import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SKILL_NAMES,
  SKILL_SOURCE,
  assessInstall,
  missingSkillsMessage,
  parseAvailableSkills,
  parseSkillsJson
} from "../scripts/install-shopify-skills.mjs";

const script = fileURLToPath(new URL("../scripts/install-shopify-skills.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("./fixtures/fake-skills-cli.mjs", import.meta.url));

test("the installer asks for the skill the toolkit ships today, not the retired per-topic names", () => {
  assert.deepEqual(SKILL_NAMES, ["shopify"]);
  assert.equal(SKILL_SOURCE, "Shopify/shopify-ai-toolkit");
});

test("parseSkillsJson finds the result array behind the CLI's progress lines", () => {
  const output = [
    "\u001b[?25l│",
    "●   claude-code_2-1-299_agent  Agent detected — installing non-interactively",
    "[",
    "  {",
    '    "name": "shopify",',
    '    "status": "installed"',
    "  }",
    "]",
    "",
    "│",
    "◇  Installation Summary ─────╮",
    "│  ~/.agents/skills/shopify  │",
    "├────────────────────────────╯",
    ""
  ].join("\n");
  assert.deepEqual(parseSkillsJson(output), [{ name: "shopify", status: "installed" }]);
  assert.deepEqual(parseSkillsJson('[\n  {\n    "status": "failed",\n    "error": "Invalid agents: nope"\n  }\n]\n'), [{ status: "failed", error: "Invalid agents: nope" }]);
  assert.equal(parseSkillsJson("◇  Found 2 skills\n■  No matching skills found for: shopify-admin\n"), null);
  assert.equal(parseSkillsJson(""), null);
});

test("parseAvailableSkills reads names out of --list output and ignores descriptions", () => {
  const output = [
    "│",
    "◇  Available Skills",
    "│",
    "│    shopify",
    "│",
    "│      Build anything on Shopify. One skill covering every Shopify developer surface: Use Shopify CLI, Admin API, ShopifyQL.",
    "│",
    "│    ucp",
    "│",
    "│      Use when the user wants to use the UCP CLI to find, compare, buy, or track products.",
    "",
    "│",
    "└  Use --skill <name> to install specific skills"
  ].join("\n");
  assert.deepEqual(parseAvailableSkills(output), ["shopify", "ucp"]);
});

test("assessInstall separates installed skills from renamed or failed ones", () => {
  assert.deepEqual(assessInstall([{ name: "shopify", status: "installed", agents: ["Claude Code"] }]), {
    installed: [{ name: "shopify", status: "installed", agents: ["Claude Code"] }],
    missing: [],
    failed: []
  });
  const renamed = assessInstall([{ name: "shopify", status: "skipped", reason: "No matching skill found in source" }]);
  assert.deepEqual(renamed.missing, ["shopify"]);
  assert.equal(renamed.installed.length, 0);
  assert.deepEqual(assessInstall([]).missing, ["shopify"]);
  assert.deepEqual(assessInstall(null).missing, ["shopify"]);
  const failed = assessInstall([{ status: "failed", error: "Invalid agents: nope" }]);
  assert.equal(failed.failed.length, 1);
  assert.deepEqual(failed.missing, ["shopify"]);
});

test("the rename message names the missing skill, the skills on offer, and what to do", () => {
  const message = missingSkillsMessage(["shopify"], ["shopify-core", "ucp"]);
  assert.match(message, /no skill named "shopify"/);
  assert.match(message, /nothing was installed/);
  assert.match(message, /shopify-core, ucp/);
  assert.match(message, /npx skills add Shopify\/shopify-ai-toolkit --skill <name> --global/);
  assert.match(message, /issues/);
  assert.match(missingSkillsMessage(["shopify"], []), /--list/);
});

function runInstaller(mode, args = []) {
  const directory = mkdtempSync(join(tmpdir(), "fake-skills-cli-"));
  const log = join(directory, "calls.log");
  writeFileSync(join(directory, "npx"), `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" "$@"\n`, { mode: 0o755 });
  try {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
        FAKE_SKILLS_MODE: mode,
        FAKE_SKILLS_LOG: log
      }
    });
    let calls = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      // No calls were logged.
    }
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const onWindows = process.platform === "win32";

test("install-shopify-skills exits non-zero and lists the available skills when upstream renamed the skill", { skip: onWindows }, () => {
  const result = runInstaller("renamed");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /has no skill named "shopify"/);
  assert.match(result.stderr, /Skills the toolkit ships today: shopify, ucp\./);
  assert.match(result.stderr, /npx skills add Shopify\/shopify-ai-toolkit --skill <name> --global/);
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls[1].includes("--list"), JSON.stringify(result.calls));
});

test("install-shopify-skills reports the installed skill and exits 0 on success", { skip: onWindows }, () => {
  const result = runInstaller("installed");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Installed shopify for Claude Code at \/home\/example\/\.claude\/skills\/shopify\./);
  assert.equal(result.calls.length, 1);
  const call = result.calls[0];
  assert.deepEqual(call.slice(0, 4), ["-y", "skills", "add", "Shopify/shopify-ai-toolkit"]);
  assert.ok(call.includes("--skill") && call.includes("shopify"), JSON.stringify(call));
  assert.ok(!call.includes("shopify-admin") && !call.includes("shopify-shopifyql"), JSON.stringify(call));
  assert.ok(call.includes("--global") && call.includes("--json") && call.includes("--yes"), JSON.stringify(call));
  assert.deepEqual(call.slice(call.indexOf("--agent"), call.indexOf("--agent") + 2), ["--agent", "*"]);
});

test("install-shopify-skills passes an agent selection through", { skip: onWindows }, () => {
  const result = runInstaller("installed", ["--agent", "codex"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const call = result.calls[0];
  assert.deepEqual(call.slice(call.indexOf("--agent"), call.indexOf("--agent") + 2), ["--agent", "codex"]);
  assert.ok(!call.includes("*"), JSON.stringify(call));
});

test("install-shopify-skills exits non-zero when the CLI prints no result", { skip: onWindows }, () => {
  const result = runInstaller("garbage");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /could not read the skills CLI result/);
});
