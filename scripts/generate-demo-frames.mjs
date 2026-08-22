#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outputDirectory = resolve(process.argv[2] ?? "docs/assets/demo-frames");
mkdirSync(outputDirectory, { recursive: true });

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

for (let frame = 1; frame <= 4; frame += 1) {
  const lines = readFileSync(new URL(`./demo-frames/${frame}.txt`, import.meta.url), "utf8").trimEnd().split("\n");
  const text = lines.map((line, index) => {
    const fill = line.startsWith("$") || line.startsWith(">") || line.includes("complete") ? "#7ee787" : "#f0f6fc";
    return `<text x="70" y="${130 + index * 46}" fill="${fill}" font-family="SFMono-Regular, Menlo, monospace" font-size="28">${escapeXml(line) || " "}</text>`;
  }).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
  <rect width="1200" height="675" fill="#0d1117"/>
  <rect x="28" y="28" width="1144" height="619" rx="18" fill="#161b22" stroke="#30363d" stroke-width="3"/>
  <path d="M46 28h1108a18 18 0 0 1 18 18v36H28V46a18 18 0 0 1 18-18z" fill="#21262d"/>
  <circle cx="65" cy="55" r="8" fill="#ff7b72"/>
  <circle cx="91" cy="55" r="8" fill="#d29922"/>
  <circle cx="117" cy="55" r="8" fill="#3fb950"/>
  <text x="600" y="63" text-anchor="middle" fill="#8b949e" font-family="SFMono-Regular, Menlo, monospace" font-size="22">shopify-multi-store</text>
  ${text}
</svg>\n`;
  writeFileSync(resolve(outputDirectory, `frame-${frame}.svg`), svg);
}
