#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const evalsDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const specsDir = join(evalsDir, "specs");

const usage = `Usage: node evals/bin/evals.mjs [spec-names...] [flags]

Run stack-lane specs:
  --with-llm-vision  Judge vision claims inline (default: defer judging)
  --daytona         Set OPENWORK_EVAL_DAYTONA=1
  --den <url>       Set OPENWORK_EVAL_DEN_API_URL=<url>

Judge then publish evidence:
  --publish         Enter judge-then-publish mode
  --pr <n>          Publish to pull request n
  --roll <value>    Select a roll directory, name, or latest (default: latest)
  --dry-run         Render publication output without posting
  --force           Forward force to the publisher

Other:
  --help, -h        Show this help

Publish mode cannot be combined with spec names, --with-llm-vision, --daytona,
or --den. Named specs auto-consent to opt-in flags declared in their source;
value-bearing environment variables are never auto-set.

Run exit codes:
  0  Passed, or a bare sweep completed with expected skips
  1  One or more tests failed
  2  A named spec skipped and its result is incomplete

Publish exit codes:
  0  Judge and publisher succeeded
  1  Failed claims were published, or publishing failed
  2  Pending claims require judging before publication
`;

export function consentVarsFromSource(text) {
  const variables = new Set();
  const optInPattern = /optIn\s*:\s*\[([^\]]*)\]/gs;
  const envPattern = /process\.env\.(OPENWORK_EVAL_[A-Z0-9_]+)(?:\?\.trim\(\))?\s*===\s*"1"/g;

  for (const match of text.matchAll(optInPattern)) {
    for (const literal of match[1].matchAll(/["'](OPENWORK_EVAL_[A-Z0-9_]+)["']/g)) {
      variables.add(literal[1]);
    }
  }
  for (const match of text.matchAll(envPattern)) variables.add(match[1]);

  return [...variables].sort();
}

function valueAfter(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseArgs(args) {
  const options = {
    specNames: [],
    withLlmVision: false,
    daytona: false,
    publish: false,
    dryRun: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--with-llm-vision") options.withLlmVision = true;
    else if (arg === "--daytona") options.daytona = true;
    else if (arg === "--publish") options.publish = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--den" || arg === "--pr" || arg === "--roll") {
      const value = valueAfter(args, index, arg);
      if (arg === "--den") options.den = value;
      else if (arg === "--pr") options.pr = value;
      else options.roll = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      options.specNames.push(arg);
    }
  }

  if (options.publish) {
    const conflicts = [];
    if (options.specNames.length > 0) conflicts.push("spec names");
    if (options.withLlmVision) conflicts.push("--with-llm-vision");
    if (options.daytona) conflicts.push("--daytona");
    if (options.den !== undefined) conflicts.push("--den");
    if (conflicts.length > 0) {
      throw new Error(`--publish is mutually exclusive with ${conflicts.join(", ")}.`);
    }
    if (!options.pr && !options.dryRun && !options.help) {
      throw new Error("--pr <n> is required unless --dry-run is set.");
    }
  } else {
    const publishFlags = [];
    if (options.pr !== undefined) publishFlags.push("--pr");
    if (options.roll !== undefined) publishFlags.push("--roll");
    if (options.dryRun) publishFlags.push("--dry-run");
    if (options.force) publishFlags.push("--force");
    if (publishFlags.length > 0) {
      throw new Error(`${publishFlags.join(", ")} require --publish.`);
    }
  }

  return options;
}

function specFiles(directory = specsDir) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /(?:\.slow)?\.test\.ts$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

export function resolveSpecNames(names, files = specFiles()) {
  const entries = files.map((file) => ({
    file,
    base: basename(file),
    relative: relative(specsDir, file).split(sep).join("/"),
  }));
  const resolved = [];

  for (const name of names) {
    const normalized = name.replace(/^\.\//, "").replace(/^specs\//, "");
    let matches = entries.filter((entry) => entry.relative === normalized);
    if (matches.length === 0) {
      matches = entries.filter((entry) =>
        entry.base === `${normalized}.test.ts` || entry.base === `${normalized}.slow.test.ts`
      );
    }
    if (matches.length === 0) {
      matches = entries.filter((entry) => entry.base.startsWith(normalized));
    }
    if (matches.length > 1) {
      throw new Error(`Spec name "${name}" is ambiguous:\n${matches.map((entry) => `  ${entry.relative}`).join("\n")}`);
    }
    if (matches.length === 0) {
      const close = entries.filter((entry) => entry.base.includes(normalized));
      throw new Error(`No spec matches "${name}". Close candidates:\n${close.length > 0 ? close.map((entry) => `  ${entry.relative}`).join("\n") : "  (none)"}`);
    }
    if (!resolved.includes(matches[0].file)) resolved.push(matches[0].file);
  }

  return resolved;
}

function reportAssertions(report) {
  if (!Array.isArray(report?.testResults)) return [];
  return report.testResults.flatMap((result) => {
    if (!Array.isArray(result?.assertionResults)) return [];
    return result.assertionResults.map((assertion) => ({ assertion, result }));
  });
}

function reportCount(report, field, status) {
  if (Number.isFinite(report?.[field])) return report[field];
  const assertions = reportAssertions(report);
  if (assertions.length === 0) return null;
  return assertions.filter(({ assertion }) => status.includes(assertion?.status)).length;
}

export function summarize(report) {
  const assertions = reportAssertions(report);
  return {
    passed: reportCount(report, "numPassedTests", ["passed"]),
    failed: reportCount(report, "numFailedTests", ["failed"]),
    skipped: reportCount(report, "numPendingTests", ["pending", "skipped", "todo", "disabled"]),
    skips: assertions
      .filter(({ assertion }) => ["pending", "skipped", "todo", "disabled"].includes(assertion?.status))
      .map(({ assertion, result }) => ({
        file: basename(result?.name ?? result?.testFilePath ?? "unknown"),
        title: assertion?.title ?? assertion?.fullName ?? "unknown",
      })),
  };
}

export function verdictFor(summary, { childExit = 0 } = {}) {
  if ((summary.failed ?? 0) > 0 || childExit !== 0) return "failed";
  if ((summary.skipped ?? 0) > 0) return "incomplete";
  return "passed";
}

export function exitCodeFor(verdict, { named = false } = {}) {
  if (verdict === "failed") return 1;
  if (verdict === "incomplete" && named) return 2;
  return 0;
}

function childStatus(result) {
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  return result.status ?? 1;
}

function publish(options) {
  const roll = options.roll ?? "latest";
  const judge = spawnSync(process.execPath, [
    join(evalsDir, "packages/fraimz/bin/judge.mjs"),
    "--roll",
    roll,
  ], { cwd: repoRoot, env: process.env, stdio: "inherit" });
  const judgeStatus = childStatus(judge);

  if (judgeStatus === 2 && !options.dryRun) {
    process.stderr.write("Pending claims need OPENAI_API_KEY or ANTHROPIC_API_KEY for judging; rerun after providing one, or use --dry-run.\n");
    return 2;
  }
  if (![0, 1, 2].includes(judgeStatus)) return judgeStatus;

  const publishArgs = [join(evalsDir, "packages/evidence/bin/publish-pr.mjs")];
  if (options.pr) publishArgs.push("--pr", options.pr);
  if (options.roll) publishArgs.push("--roll", options.roll);
  if (options.dryRun) publishArgs.push("--dry-run");
  if (options.force) publishArgs.push("--force");
  const published = spawnSync(process.execPath, publishArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  const publishStatus = childStatus(published);
  return judgeStatus === 1 && publishStatus === 0 ? 1 : publishStatus;
}

function run(options) {
  const resolved = resolveSpecNames(options.specNames);
  const childEnv = { ...process.env, OPENWORK_EVAL_APP_SPECS: "1" };
  const consented = new Set(["OPENWORK_EVAL_APP_SPECS"]);

  for (const file of resolved) {
    for (const variable of consentVarsFromSource(readFileSync(file, "utf8"))) {
      if (Object.hasOwn(process.env, variable)) continue;
      childEnv[variable] = "1";
      consented.add(variable);
    }
  }
  if (options.withLlmVision) delete childEnv.OPENWORK_EVAL_VISION;
  else childEnv.OPENWORK_EVAL_VISION = "defer";
  if (options.daytona) childEnv.OPENWORK_EVAL_DAYTONA = "1";
  if (options.den !== undefined) childEnv.OPENWORK_EVAL_DEN_API_URL = options.den;

  const outputDir = join(evalsDir, "results/.testkit");
  mkdirSync(outputDir, { recursive: true });
  const outputFile = join(outputDir, `cli-run-${Date.now()}.json`);
  const vitestArgs = [
    "exec", "vitest", "run",
    "--config", "vitest.config.ts",
    "--project", "stack",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${outputFile}`,
    ...resolved.map((file) => relative(evalsDir, file).split(sep).join("/")),
  ];
  const child = spawnSync("pnpm", vitestArgs, { cwd: evalsDir, env: childEnv, stdio: "inherit" });
  const status = childStatus(child);
  let report;
  try {
    const parsed = JSON.parse(readFileSync(outputFile, "utf8"));
    if (!Number.isFinite(parsed?.numTotalTests) || !Array.isArray(parsed?.testResults)) {
      throw new Error("Invalid Vitest JSON report.");
    }
    report = parsed;
  } catch {
    report = undefined;
  }
  const summary = summarize(report);
  const verdict = verdictFor(summary, { childExit: status });
  process.stdout.write(`${JSON.stringify({
    command: "evals",
    lane: "stack",
    daytona: options.daytona,
    vision: options.withLlmVision ? "inline" : "defer",
    files: options.specNames.length > 0 ? options.specNames : ["all"],
    ...summary,
    consented: [...consented].sort(),
    verdict,
  })}\n`);
  return exitCodeFor(verdict, { named: resolved.length > 0 });
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(usage);
      return 0;
    }
    return options.publish ? publish(options) : run(options);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
