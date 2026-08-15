#!/usr/bin/env node
import { access, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeRoll } from "../src/tape.ts";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const rollsDir = join(repoRoot, "evals", "results", "rolls");
const args = process.argv.slice(2);
let rollArg;
let force = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--") continue;
  if (arg === "--force") {
    force = true;
    continue;
  }
  if (arg === "--roll") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--roll requires a value.");
    rollArg = value;
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

if (!rollArg) throw new Error("--roll <dir|latest> is required.");

async function hasRoll(directory) {
  try {
    await access(join(directory, "roll.json"));
    return true;
  } catch {
    return false;
  }
}

async function latestRoll() {
  const entries = await readdir(rollsDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const directory of directories) {
    const candidate = join(rollsDir, directory);
    if (await hasRoll(candidate)) return candidate;
  }
  return undefined;
}

async function resolveRoll() {
  if (rollArg === "latest") return latestRoll();
  const candidates = [
    isAbsolute(rollArg) ? rollArg : resolve(process.cwd(), rollArg),
    resolve(repoRoot, rollArg),
    join(rollsDir, rollArg),
  ];
  for (const candidate of candidates) {
    if (await hasRoll(candidate)) return candidate;
  }
  return undefined;
}

const rollDir = await resolveRoll();
if (!rollDir) throw new Error(`No photo roll found for ${rollArg}.`);

const result = await judgeRoll(rollDir, { force });
for (const error of result.errors) process.stderr.write(`Pending: ${error}\n`);
process.stdout.write(`Judged ${result.judgedClaims} claim(s): ${result.failedClaims} failed, ${result.pendingClaims} pending.\n${result.rollPath}\n`);
process.exitCode = result.pendingClaims > 0 ? 2 : result.failedClaims > 0 ? 1 : 0;
