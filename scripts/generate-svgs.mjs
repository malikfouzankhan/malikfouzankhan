#!/usr/bin/env node
// Generates the animated terminal SVGs used in README.md.
// Edit the content below, then run:  node scripts/generate-svgs.mjs
// Output: assets/hero-{dark,light}.svg and assets/footer-{dark,light}.svg

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets");

// ───────────────────────────── content ─────────────────────────────

const HERO = {
  title: "mfk@fouzan.dev: ~",
  command: "curl -s https://api.fouzan.dev/v1/whoami",
  status: "HTTP/2 200 OK  content-type: application/json  38ms",
  json: [
    "{",
    '  "name": "Malik Fouzan Khan",',
    '  "alias": "MFK",',
    '  "location": "Hyderabad, IN",',
    '  "roles": [',
    '    { "title": "Software Engineer", "at": "Zenoids Technologies" },',
    '    { "title": "Trainer (part-time)", "at": "Code For India Foundation" }',
    "  ],",
    '  "core": "backend systems that survive production",',
    '  "status": "open_to_freelance"',
    "}",
  ],
};

const FOOTER = {
  title: "mfk@fouzan.dev: ~",
  command: "curl -s https://api.fouzan.dev/v1/profile?scroll=more",
  status: "HTTP/2 429 Too Many Requests  retry-after: never",
  json: [
    "{",
    '  "error": "end_of_profile",',
    '  "hint": "rate limit resets when you say hi on LinkedIn"',
    "}",
  ],
};

// ───────────────────────────── themes ──────────────────────────────

const THEMES = {
  dark: {
    bg: "#0d1117",
    chrome: "#161b22",
    border: "#30363d",
    text: "#c9d1d9",
    dim: "#6e7681",
    prompt: "#39d353",
    key: "#7ee787",
    str: "#a5d6ff",
    punct: "#8b949e",
    ok: "#39d353",
    warn: "#e3b341",
    dots: ["#ff7b72", "#e3b341", "#39d353"],
  },
  light: {
    bg: "#ffffff",
    chrome: "#f6f8fa",
    border: "#d0d7de",
    text: "#1f2328",
    dim: "#6e7781",
    prompt: "#1a7f37",
    key: "#116329",
    str: "#0a3069",
    punct: "#57606a",
    ok: "#1a7f37",
    warn: "#9a6700",
    dots: ["#cf222e", "#bf8700", "#1a7f37"],
  },
};

// ───────────────────────────── layout ──────────────────────────────

const W = 860;
const PAD_X = 28;
const CHROME_H = 38;
const FONT = 14.5;
const CHAR_W = 8.7; // fixed via textLength on typed lines
const LINE_H = 23;
const TOP = CHROME_H + 30;
const FONT_STACK =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

// ───────────────────────────── helpers ─────────────────────────────

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Split a JSON-ish line into colored tokens.
function tokenize(line) {
  const tokens = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|([{}\[\],:])|(\s+)|([^\s"{}\[\],:]+)/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1] && m[2]) {
      tokens.push({ t: m[1], c: "key" });
      tokens.push({ t: m[2], c: "punct" });
    } else if (m[1]) tokens.push({ t: m[1], c: "str" });
    else if (m[3]) tokens.push({ t: m[3], c: "punct" });
    else if (m[4]) tokens.push({ t: m[4], c: "text" });
    else tokens.push({ t: m[5], c: "text" });
  }
  return tokens;
}

function renderJsonLine(line, y, cls) {
  const indent = line.match(/^\s*/)[0].length;
  const body = line.trimStart();
  const spans = tokenize(body)
    .map((tk) => `<tspan class="${tk.c}">${esc(tk.t)}</tspan>`)
    .join("");
  const x = PAD_X + indent * CHAR_W;
  return `<text class="${cls}" x="${x}" y="${y}" xml:space="preserve">${spans}</text>`;
}

function buildTerminal({ title, command, status, json }, theme, { statusKind }) {
  const th = THEMES[theme];
  const lines = 1 + 1 + json.length + 1; // command, status, json, cursor line
  const H = TOP + lines * LINE_H + 10;

  // timeline (seconds)
  const typeStart = 0.4;
  const typeDur = Math.min(1.8, command.length * 0.035);
  const respStart = typeStart + typeDur + 0.35;
  const step = 0.09;

  const promptW = 2 * CHAR_W; // "$ "
  const cmdX = PAD_X + promptW;
  const cmdW = command.length * CHAR_W;

  let y = TOP;
  const parts = [];

  // command line
  parts.push(
    `<text class="prompt" x="${PAD_X}" y="${y}">$</text>`,
    `<text class="text" x="${cmdX}" y="${y}" textLength="${cmdW}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(command)}</text>`,
    `<rect class="typer" x="${cmdX - 1}" y="${y - FONT}" width="${cmdW + 4}" height="${LINE_H}" />`
  );
  y += LINE_H;

  // status line
  const statusColor = statusKind === "warn" ? "warn" : "ok";
  parts.push(
    `<text class="reveal ${statusColor}" style="animation-delay:${respStart.toFixed(2)}s" x="${PAD_X}" y="${y}" xml:space="preserve">&lt; ${esc(status)}</text>`
  );
  y += LINE_H;

  // json body
  json.forEach((line, i) => {
    const delay = respStart + (i + 1) * step;
    parts.push(
      renderJsonLine(line, y, "reveal").replace(
        'class="reveal"',
        `class="reveal" style="animation-delay:${delay.toFixed(2)}s"`
      )
    );
    y += LINE_H;
  });

  // trailing prompt + cursor
  const endDelay = respStart + (json.length + 1) * step + 0.1;
  parts.push(
    `<text class="reveal prompt" style="animation-delay:${endDelay.toFixed(2)}s" x="${PAD_X}" y="${y}">$</text>`,
    `<rect class="cursor" style="animation-delay:${endDelay.toFixed(2)}s" x="${cmdX}" y="${y - FONT + 2}" width="${CHAR_W}" height="${FONT + 3}" />`
  );

  const dots = th.dots
    .map((c, i) => `<circle cx="${PAD_X - 6 + i * 20}" cy="${CHROME_H / 2}" r="6" fill="${c}" />`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(`$ ${command}\n${status}\n${json.join("\n")}`)}</desc>
<style>
  text { font-family: ${FONT_STACK}; font-size: ${FONT}px; fill: ${th.text}; }
  .prompt { fill: ${th.prompt}; font-weight: 700; }
  .key { fill: ${th.key}; }
  .str { fill: ${th.str}; }
  .punct { fill: ${th.punct}; }
  .text { fill: ${th.text}; }
  .ok { fill: ${th.ok}; }
  .warn { fill: ${th.warn}; }
  .title { fill: ${th.dim}; font-size: 12.5px; }
  .typer { fill: ${th.bg}; animation: type ${typeDur.toFixed(2)}s steps(${command.length}, end) ${typeStart}s forwards; }
  .reveal { opacity: 0; animation: in 0.01s linear forwards; }
  .cursor { fill: ${th.prompt}; opacity: 0; animation: in 0.01s linear forwards, blink 1.1s steps(1, end) infinite; }
  @keyframes type { to { transform: translateX(${cmdW + 4}px); } }
  @keyframes in { to { opacity: 1; } }
  @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .typer { display: none; }
    .reveal, .cursor { opacity: 1; animation: none; }
  }
</style>
<defs><clipPath id="win"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" /></clipPath></defs>
<g clip-path="url(#win)">
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="${th.bg}" />
  <rect x="1" y="1" width="${W - 2}" height="${CHROME_H}" fill="${th.chrome}" />
  <line x1="1" y1="${CHROME_H + 1}" x2="${W - 1}" y2="${CHROME_H + 1}" stroke="${th.border}" />
  ${dots}
  <text class="title" x="${W / 2}" y="${CHROME_H / 2 + 4}" text-anchor="middle">${esc(title)}</text>
  ${parts.join("\n  ")}
</g>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="none" stroke="${th.border}" />
</svg>
`;
}

// ───────────────────────────── build ───────────────────────────────

mkdirSync(OUT, { recursive: true });
for (const theme of Object.keys(THEMES)) {
  writeFileSync(join(OUT, `hero-${theme}.svg`), buildTerminal(HERO, theme, { statusKind: "ok" }));
  writeFileSync(join(OUT, `footer-${theme}.svg`), buildTerminal(FOOTER, theme, { statusKind: "warn" }));
}
console.log("✔ generated hero + footer SVGs (dark, light) in assets/");
