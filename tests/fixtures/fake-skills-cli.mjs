// Stands in for `npx skills add ...` in tests/install-shopify-skills.test.mjs.
// FAKE_SKILLS_MODE picks the upstream state to imitate:
//   installed  the toolkit ships the requested skill and the CLI installs it
//   renamed    the toolkit renamed the skill; the CLI skips it and exits 0
//   garbage    the CLI prints no JSON at all
// Every call is logged to FAKE_SKILLS_LOG so the test can check the arguments.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_SKILLS_LOG) appendFileSync(process.env.FAKE_SKILLS_LOG, `${JSON.stringify(args)}\n`);

const mode = process.env.FAKE_SKILLS_MODE ?? "installed";
const requested = [];
const skillFlag = args.indexOf("--skill");
if (skillFlag !== -1) {
  for (const arg of args.slice(skillFlag + 1)) {
    if (arg.startsWith("--")) break;
    requested.push(arg);
  }
}

if (args.includes("--list")) {
  process.stdout.write([
    "\u001b[?25h",
    "│",
    "◇  Available Skills",
    "│",
    "│    shopify",
    "│",
    "│      Build anything on Shopify. One skill covering every Shopify developer surface.",
    "│",
    "│    ucp",
    "│",
    "│      Use when the user wants to use the UCP CLI to find, compare, buy, or track products.",
    "",
    "│",
    "└  Use --skill <name> to install specific skills",
    ""
  ].join("\n"));
  process.exit(0);
}

if (mode === "garbage") {
  process.stdout.write("◇  Found 2 skills\n■  Something unexpected happened\n");
  process.exit(0);
}

if (mode === "renamed") {
  process.stdout.write(`${JSON.stringify(requested.map((name) => ({
    name,
    status: "skipped",
    reason: "No matching skill found in source"
  })), null, 2)}\n`);
  process.exit(0);
}

process.stdout.write("●   claude-code_2-1-299_agent  Agent detected — installing non-interactively\n");
process.stdout.write(`${JSON.stringify(requested.map((name) => ({
  name,
  status: "installed",
  source: "Shopify/shopify-ai-toolkit",
  ref: null,
  hash: "20628b46f942f7a248cd497a2fc8abeda44ef1f155cdae7fb2cab86739fbe5eb",
  path: `/home/example/.claude/skills/${name}`,
  scope: "global",
  agents: ["Claude Code"],
  mode: "copy"
})), null, 2)}\n`);
process.stderr.write("│\n◇  Installation Summary ─────╮\n│  ~/.agents/skills/shopify  │\n├────────────────────────────╯\n");
