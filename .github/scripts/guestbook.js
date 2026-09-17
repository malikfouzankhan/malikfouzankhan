// Guestbook for the profile README.
// Runs inside actions/github-script. Two exported steps:
//   processRequest -> validates the issue, updates guestbook/entries.json + README.md
//   respond        -> comments on the issue with an API-style status and closes/labels it
//
// Mode comes from the GUESTBOOK_MODE env var set in .github/workflows/guestbook.yml:
//   instant  : valid messages go live as soon as the issue is opened
//   approved : valid messages wait for you to add the "approved" label

const fs = require("fs");
const path = require("path");

const MODE = (process.env.GUESTBOOK_MODE || "instant").trim().toLowerCase();

const README = "README.md";
const DB = path.join("guestbook", "entries.json");
const START = "<!-- GUESTBOOK:START -->";
const END = "<!-- GUESTBOOK:END -->";

const SHOW_LIMIT = 5; // rows shown on the profile
const KEEP_LIMIT = 50; // rows kept in entries.json
const MAX_LEN = 80; // characters per message
const COOLDOWN_HOURS = 24; // one entry per user per window

const LABELS = {
  guestbook: { name: "guestbook", color: "39d353", description: "POST /guestbook requests" },
  pending: { name: "pending", color: "e3b341", description: "Guestbook entry waiting for approval" },
  approved: { name: "approved", color: "1a7f37", description: "Approve this guestbook entry" },
};

const BLOCKLIST = require("./blocklist.json").map((w) => w.toLowerCase());

// ───────────────────────────── helpers ─────────────────────────────

function extractMessage(body = "") {
  // Issue forms render inputs as "### Message\n\n<value>"
  const match = body.match(/###\s*Message\s*\n+([\s\S]*?)(?=\n###|\s*$)/i);
  let text = (match ? match[1] : body || "").trim();
  if (text === "_No response_") text = "";
  return text;
}

function sanitize(text) {
  const cleaned = text
    .replace(/https?:\/\/\S+|www\.\S+/gi, "") // no links
    .replace(/<[^>]*>/g, "") // no html
    .replace(/[`*_~#>|\[\]\\{}]/g, "") // no markdown control chars
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, " ") // control + bidi chars
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, MAX_LEN).join("").trim();
}

function isBlocked(text) {
  const normalized = text
    .toLowerCase()
    .replace(/[0@4]/g, (c) => ({ 0: "o", "@": "a", 4: "a" })[c])
    .replace(/[1!]/g, "i")
    .replace(/3/g, "e")
    .replace(/[5$]/g, "s")
    .replace(/[^a-z\s]/g, "");
  const words = normalized.split(/\s+/);
  const squashed = normalized.replace(/\s+/g, "");
  return BLOCKLIST.some((bad) => words.includes(bad) || (bad.length >= 5 && squashed.includes(bad)));
}

function loadEntries() {
  try {
    return JSON.parse(fs.readFileSync(DB, "utf8"));
  } catch {
    return [];
  }
}

function renderBlock(entries) {
  const rows = entries.slice(0, SHOW_LIMIT);
  let body;
  if (rows.length === 0) {
    body = [
      "GET /guestbook?limit=5",
      "< HTTP/2 204 No Content",
      "",
      "  no requests yet. be the first one.",
    ];
  } else {
    const width = Math.max(...rows.map((r) => r.login.length)) + 3;
    body = [
      "GET /guestbook?limit=5",
      "< HTTP/2 200 OK",
      "",
      ...rows.map((r) => `  ${r.date}  ${("@" + r.login).padEnd(width)} "${r.message}"`),
    ];
  }
  return `${START}\n\`\`\`text\n${body.join("\n")}\n\`\`\`\n${END}`;
}

function writeReadme(entries) {
  const readme = fs.readFileSync(README, "utf8");
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (!pattern.test(readme)) throw new Error("Guestbook markers not found in README.md");
  fs.writeFileSync(README, readme.replace(pattern, renderBlock(entries)));
}

async function canApprove(github, owner, repo, username) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return ["admin", "maintain", "write"].includes(data.permission);
  } catch {
    return false;
  }
}

async function ensureLabel(github, owner, repo, label) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: label.name });
  } catch {
    try {
      await github.rest.issues.createLabel({ owner, repo, ...label });
    } catch {
      /* label race or permissions, safe to ignore */
    }
  }
}

// ───────────────────────────── step 1 ──────────────────────────────

async function processRequest({ github, context, core }) {
  const { owner, repo } = context.repo;
  const { action, issue, label, sender } = context.payload;

  core.setOutput("write", "false");
  core.setOutput("status", "");
  core.setOutput("next", "");

  if (!issue || issue.pull_request) return;
  if (issue.user?.type === "Bot") return core.info("Ignoring bot issue.");
  if (issue.state === "closed") return core.info("Issue already closed.");

  const login = issue.user.login;
  const message = sanitize(extractMessage(issue.body));
  const entries = loadEntries();

  if (entries.some((e) => e.issue === issue.number)) return core.info("Entry already exists.");

  // APPROVAL MODE: only continue on the "approved" label from someone with write access
  if (action === "labeled") {
    if (MODE !== "approved") return core.info("Label event ignored in instant mode.");
    if (label?.name !== LABELS.approved.name) return core.info(`Ignoring label "${label?.name}".`);
    if (!(await canApprove(github, owner, repo, sender.login))) {
      return core.info(`${sender.login} cannot approve entries.`);
    }
  }

  // validation
  const cutoff = Date.now() - COOLDOWN_HOURS * 3600 * 1000;
  const reject = (status) => {
    core.setOutput("status", status);
    core.setOutput("next", "close");
  };
  if (!message) return reject("400");
  if (isBlocked(message)) return reject("422");
  if (entries.some((e) => e.login === login && Date.parse(e.created_at) > cutoff)) return reject("429");

  // APPROVAL MODE: park valid requests until approved
  if (action === "opened" && MODE === "approved") {
    core.setOutput("status", "202");
    core.setOutput("next", "pending");
    return;
  }

  // create entry
  const now = new Date();
  entries.unshift({
    login,
    message,
    issue: issue.number,
    date: now.toISOString().slice(0, 10),
    created_at: now.toISOString(),
  });
  const kept = entries.slice(0, KEEP_LIMIT);

  fs.mkdirSync(path.dirname(DB), { recursive: true });
  fs.writeFileSync(DB, JSON.stringify(kept, null, 2) + "\n");
  writeReadme(kept);

  core.setOutput("write", "true");
  core.setOutput("status", "201");
  core.setOutput("next", "close");
}

// ───────────────────────────── step 2 ──────────────────────────────

const RESPONSES = {
  201: (login, message, profile) => ({
    head: "201 Created",
    json: { from: `@${login}`, message, location: profile },
    note: "Thanks for stopping by. Your message is live on the profile.",
  }),
  202: (login, message) => ({
    head: "202 Accepted",
    json: { from: `@${login}`, message, state: "pending_review" },
    note: "Got it. Your message shows up on the profile once it's approved.",
  }),
  400: () => ({
    head: "400 Bad Request",
    json: { error: "empty_message", detail: `Write a message (max ${MAX_LEN} characters) and open a new request.` },
    note: "Nothing was posted.",
  }),
  422: () => ({
    head: "422 Unprocessable Entity",
    json: { error: "content_rejected", detail: "The message didn't pass the content filter." },
    note: "Nothing was posted. Keep it friendly and try again.",
  }),
  429: () => ({
    head: "429 Too Many Requests",
    json: { error: "rate_limited", detail: `One message per ${COOLDOWN_HOURS} hours.` },
    note: "Your earlier message is already on the board.",
  }),
};

async function respond({ github, context, core }) {
  const { owner, repo } = context.repo;
  const issue = context.payload.issue;
  const status = process.env.GB_STATUS;
  const next = process.env.GB_NEXT;
  if (!status || !RESPONSES[status]) return;

  const login = issue.user.login;
  const message = sanitize(extractMessage(issue.body));
  const profile = `https://github.com/${owner}`;
  const r = RESPONSES[status](login, message, profile);

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issue.number,
    body: `**\`HTTP/2 ${r.head}\`**\n\n\`\`\`json\n${JSON.stringify(r.json, null, 2)}\n\`\`\`\n\n${r.note}`,
  });

  await ensureLabel(github, owner, repo, LABELS.guestbook);
  await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: [LABELS.guestbook.name] });

  if (next === "pending") {
    await ensureLabel(github, owner, repo, LABELS.pending);
    await ensureLabel(github, owner, repo, LABELS.approved);
    await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: [LABELS.pending.name] });
    return;
  }

  if (next === "close") {
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: issue.number, name: LABELS.pending.name });
    } catch {
      /* label wasn't there */
    }
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: issue.number,
      state: "closed",
      state_reason: status === "201" ? "completed" : "not_planned",
    });
  }
}

module.exports = { processRequest, respond, sanitize, extractMessage, isBlocked, renderBlock, loadEntries, writeReadme };
