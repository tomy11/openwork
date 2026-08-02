#!/usr/bin/env node
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishPr, scanRolls } from "../src/index.ts";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const resultsDir = join(repoRoot, "evals", "results");
const args = process.argv.slice(2);
let pr;
let rollArg;
let dryRun = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--dry-run") {
    dryRun = true;
    continue;
  }
  if (arg === "--pr" || arg === "--roll") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    if (arg === "--pr") pr = value;
    else rollArg = value;
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

if (!dryRun && !pr) throw new Error("--pr <n> is required unless --dry-run is set.");
const entries = (await scanRolls(resultsDir)).filter((entry) => entry.kind === "roll");
let rollDir;
if (rollArg) {
  const candidate = isAbsolute(rollArg) ? rollArg : resolve(process.cwd(), rollArg);
  if (existsSync(join(candidate, "roll.json"))) rollDir = candidate;
  else {
    const selected = entries.find((entry) => entry.directoryName === rollArg || entry.name === rollArg);
    rollDir = selected?.directoryPath;
  }
} else {
  rollDir = entries[0]?.directoryPath;
}
if (!rollDir) throw new Error(`No photo roll found${rollArg ? ` for ${rollArg}` : ""}.`);

const result = await publishPr({ pr, rollDir, dryRun });
if (!dryRun) process.stdout.write(`${result.updated ? "Updated" : "Posted"} photo roll for PR ${pr}.\n`);
