#!/usr/bin/env node
// Installs Shopify's official `shopify` skill from Shopify/shopify-ai-toolkit
// with the `skills` CLI, and fails loudly when the toolkit no longer ships a
// skill under that name. Shopify renamed its skills once already: toolkit 2.0.0
// (2026) collapsed `shopify-admin`, `shopify-shopifyql` and twenty other
// per-topic skills into one `shopify` skill. The `skills` CLI treats an unknown
// name as "skipped" and still exits 0, so this script checks the result itself.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_SOURCE = "Shopify/shopify-ai-toolkit";
export const SKILL_NAMES = ["shopify"];
export const ISSUES_URL = "https://github.com/alex-brecher/shopify-multi-store/issues";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * Runs `npx -y skills add <source> ...args` and returns stdout, stderr and the exit status.
 * `--yes` always goes last so a non-interactive run never waits on a prompt.
 */
export function runSkillsCli(args, { env = process.env } = {}) {
  const result = spawnSync(NPX, ["-y", "skills", "add", SKILL_SOURCE, ...args, "--yes"], {
    encoding: "utf8",
    env,
    shell: process.platform === "win32"
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

/**
 * Finds the JSON array the `skills` CLI prints in --json mode. The CLI prints
 * human-readable lines before and after the array (the summary boxes go to
 * stderr), and prints a failure array on stderr, so this tries every pair of
 * lines that open and close an array and keeps the last pair that parses.
 */
export function parseSkillsJson(output) {
  const text = output.replace(ANSI, "");
  const lines = text.split(/\r?\n/);
  const opens = [];
  const closes = [];
  lines.forEach((line, index) => {
    if (line.trim() === "[") opens.push(index);
    if (line.trim() === "]") closes.push(index);
  });
  let parsed = null;
  for (const open of opens) {
    for (const close of closes) {
      if (close <= open) continue;
      try {
        const candidate = JSON.parse(lines.slice(open, close + 1).join("\n"));
        if (Array.isArray(candidate)) {
          parsed = candidate;
          break;
        }
      } catch {
        // Not a complete array yet; try the next closing line.
      }
    }
  }
  return parsed;
}

/**
 * Reads skill names out of `skills add <source> --list` output. Names sit on
 * their own line, indented four spaces after the box-drawing margin; the
 * descriptions below them are indented six.
 */
export function parseAvailableSkills(output) {
  const names = [];
  for (const rawLine of output.replace(ANSI, "").split(/\r?\n/)) {
    const line = rawLine.replace(/^[^\x20-\x7e]+/, "");
    const match = /^ {2,4}([A-Za-z0-9][\w.-]*)\s*$/.exec(line);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * Compares the --json results against the skills this script asked for.
 * Returns the installed entries, the names the toolkit did not have, and any
 * failure entries the CLI reported.
 */
export function assessInstall(results, requested = SKILL_NAMES) {
  const entries = Array.isArray(results) ? results : [];
  const failed = entries.filter((entry) => entry && entry.status === "failed");
  const installed = [];
  const missing = [];
  for (const name of requested) {
    const entry = entries.find((candidate) => candidate && candidate.name === name);
    if (entry && entry.status === "installed") installed.push(entry);
    else missing.push(name);
  }
  return { installed, missing, failed };
}

export function missingSkillsMessage(missing, available) {
  const lines = [
    `install-shopify-skills: ${SKILL_SOURCE} has no skill named ${missing.map((name) => `"${name}"`).join(", ")}, so nothing was installed.`
  ];
  if (available.length) {
    lines.push(`Skills the toolkit ships today: ${available.join(", ")}.`);
  } else {
    lines.push(`List the toolkit's skills with: npx skills add ${SKILL_SOURCE} --list`);
  }
  lines.push(
    "Shopify has renamed its skills before (toolkit 2.0.0 merged shopify-admin and shopify-shopifyql into shopify).",
    `Install the current name yourself with: npx skills add ${SKILL_SOURCE} --skill <name> --global`,
    `Then report the new name at ${ISSUES_URL} so this command can follow it.`
  );
  return lines.join("\n");
}

export function installedMessage(installed) {
  return installed
    .map((entry) => {
      const agents = Array.isArray(entry.agents) && entry.agents.length ? entry.agents.join(", ") : "the detected agents";
      const where = entry.path ? ` at ${entry.path}` : "";
      return `Installed ${entry.name} for ${agents}${where}.`;
    })
    .join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const selection = argv.length ? argv : ["--agent", "*"];
  process.stdout.write(`Installing Shopify's official ${SKILL_NAMES.join(", ")} skill from ${SKILL_SOURCE}.\n`);
  process.stdout.write("It covers Admin GraphQL, ShopifyQL and every other Shopify developer topic.\n");
  process.stdout.write("The skill's scripts send usage telemetry by default. Set OPT_OUT_INSTRUMENTATION=true to turn it off.\n");

  const run = runSkillsCli(["--skill", ...SKILL_NAMES, "--global", ...selection, "--json"]);
  const results = parseSkillsJson(`${run.stdout}\n${run.stderr}`);
  if (!results) {
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    process.stderr.write("install-shopify-skills: could not read the skills CLI result. Nothing is known to be installed.\n");
    return run.status === 0 ? 1 : run.status;
  }

  const { installed, missing, failed } = assessInstall(results);
  for (const entry of failed) {
    process.stderr.write(`install-shopify-skills: the skills CLI failed: ${entry.error ?? "unknown error"}\n`);
  }
  if (failed.length) return 1;

  if (missing.length) {
    const listing = runSkillsCli(["--list"]);
    const available = parseAvailableSkills(`${listing.stdout}\n${listing.stderr}`);
    process.stderr.write(`${missingSkillsMessage(missing, available)}\n`);
    return 1;
  }

  process.stdout.write(`${installedMessage(installed)}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = main();
}
