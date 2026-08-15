import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Shot } from "./screenshot.ts";
import { judgeVision } from "./validate.ts";
import type { SeenFacts, SeenResult, ValidateOptions } from "./validate.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

export type RollJudgmentState = "passed" | "failed" | "pending";

export interface RollJudgment {
  expectation: string;
  state: RollJudgmentState;
  reasoning: string;
}

export interface RollFrame {
  caption: string;
  fileName: string;
  hash: string;
  route: string;
  at: string;
  description: string;
  model: string;
  ok: boolean | null;
  results: SeenResult[];
  judgments: RollJudgment[];
}

export interface RollSummary {
  ok: boolean;
  totalFrames: number;
  passedFrames: number;
  failedFrames: number;
  unvalidatedFrames: number;
  pendingFrames: number;
  passedExpectations: number;
  failedExpectations: number;
  pendingJudgments: number;
}

export interface RollRecord {
  name: string;
  dir: string;
  createdAt: string;
  closedAt: string;
  gitSha?: string;
  branch?: string;
  summary: RollSummary;
  frames: RollFrame[];
}

interface StoredFrame extends RollFrame {
  sequence: number;
  png: Buffer | null;
  claimKey: string | null;
}

export interface Tape {
  readonly dir: string;
  recordTake(shot: Shot): string;
  claim(shotHash: string, seen: SeenFacts): string;
  fact(claim: string, evidence: string, passed: boolean): void;
  close(): Promise<string>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface JudgeRollOptions extends ValidateOptions {
  force?: boolean;
}

export interface JudgeRollResult {
  rollPath: string;
  judgedClaims: number;
  failedClaims: number;
  pendingClaims: number;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "frame";
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fileName(sequence: number, caption: string): string {
  return `${String(sequence).padStart(2, "0")}-${slug(caption)}.png`;
}

function judgmentsForSeen(seen: SeenFacts): RollJudgment[] {
  if (seen.deferred) {
    if (!seen.pendingExpectations) throw new Error("Deferred vision facts must include pending expectations.");
    return seen.pendingExpectations.map((expectation) => ({
      expectation,
      state: "pending",
      reasoning: seen.why,
    }));
  }
  return seen.results.map((result) => ({
    expectation: result.expectation,
    state: result.passed ? "passed" : "failed",
    reasoning: result.evidence,
  }));
}

function frameCaption(name: string, sequence: number, seen?: SeenFacts): string {
  return seen?.results[0]?.expectation.trim()
    || seen?.pendingExpectations?.[0]?.trim()
    || `${name} frame ${sequence}`;
}

function claimKey(seen: SeenFacts): string {
  return JSON.stringify(judgmentsForSeen(seen).map((judgment) => judgment.expectation.trim()));
}

function gitValue(args: string[]): string {
  const result = spawnSync("git", ["rev-parse", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 && !result.error ? result.stdout.trim() : "";
}

function rollFrame(frame: StoredFrame): RollFrame {
  return {
    caption: frame.caption,
    fileName: frame.fileName,
    hash: frame.hash,
    route: frame.route,
    at: frame.at,
    description: frame.description,
    model: frame.model,
    ok: frame.ok,
    results: frame.results,
    judgments: frame.judgments,
  };
}

function summarize(frames: RollFrame[]): RollSummary {
  const judgments = frames.flatMap((frame) => frame.judgments);
  const pendingFrames = frames.filter((frame) => frame.judgments.some((judgment) => judgment.state === "pending")).length;
  return {
    ok: frames.length > 0 && frames.every((frame) => frame.ok === true),
    totalFrames: frames.length,
    passedFrames: frames.filter((frame) => frame.ok === true).length,
    failedFrames: frames.filter((frame) => frame.ok === false).length,
    // Pending frames remain part of this legacy count so older evidence readers
    // still display them as unvalidated instead of silently green.
    unvalidatedFrames: frames.filter((frame) => frame.ok === null).length,
    pendingFrames,
    passedExpectations: judgments.filter((judgment) => judgment.state === "passed").length,
    failedExpectations: judgments.filter((judgment) => judgment.state === "failed").length,
    pendingJudgments: judgments.filter((judgment) => judgment.state === "pending").length,
  };
}

function renderFrame(frame: RollFrame): string {
  const pending = frame.judgments.some((judgment) => judgment.state === "pending");
  const stateClass = pending ? "pending" : frame.ok === true ? "passed" : frame.ok === false ? "failed" : "unvalidated";
  const description = frame.description || (pending ? "Vision judgment pending." : "Not vision-validated.");
  return `
      <article class="frame ${stateClass}">
        <h2>${html(frame.caption)}</h2>
        <p class="meta">${html(frame.route)} · ${html(frame.at)}${frame.model ? ` · ${html(frame.model)}` : ""}</p>
        ${frame.fileName ? `<img src="${html(frame.fileName)}" alt="${html(frame.caption)}">` : ""}
        <p>${html(description)}</p>
        <ul>${frame.judgments.map((judgment) => `<li class="${judgment.state}"><strong>${judgment.state.toUpperCase()}</strong> ${html(judgment.expectation)} — ${html(judgment.reasoning)}</li>`).join("")}</ul>
      </article>`;
}

function renderIndex(record: RollRecord): string {
  const summary = record.summary;
  const claimedFrames = record.frames.filter((frame) => frame.judgments.length > 0).map(renderFrame).join("");
  const unclaimedFrames = record.frames.filter((frame) => frame.judgments.length === 0);
  const unclaimedMarkup = unclaimedFrames.length > 0
    ? `<details class="unclaimed-takes unvalidated"><summary>unclaimed takes (${unclaimedFrames.length})</summary>${unclaimedFrames.map(renderFrame).join("")}</details>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(record.name)} photo roll</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;background:#f6f7f9;color:#17191d}header,.frame,details{background:white;border:1px solid #dfe2e8;border-radius:12px;padding:20px;margin:0 0 24px}.frame.passed{border-left:6px solid #238636}.frame.failed{border-left:6px solid #cf222e}.frame.pending,.frame.unvalidated,details.unvalidated{border-left:6px solid #9a6700}details .frame{margin-top:20px}summary{cursor:pointer;font-weight:700}img{display:block;width:100%;height:auto;border:1px solid #dfe2e8;border-radius:8px}.meta{color:#636c76}.passed strong{color:#1a7f37}.failed strong{color:#cf222e}.pending strong{color:#9a6700}li{margin:8px 0}
</style></head><body><header><h1>${html(record.name)}</h1><p>${summary.passedFrames}/${summary.totalFrames} frames passed; ${summary.failedFrames} failed; ${summary.pendingFrames} pending; ${summary.unvalidatedFrames - summary.pendingFrames} unclaimed. ${summary.passedExpectations} judgments passed, ${summary.failedExpectations} failed, and ${summary.pendingJudgments} pending.</p></header>${claimedFrames}${unclaimedMarkup}</body></html>
`;
}

async function writeRoll(record: RollRecord, rollDir: string): Promise<void> {
  await writeFile(join(rollDir, "roll.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(join(rollDir, "index.html"), renderIndex(record), "utf8");
}

function parseResult(value: unknown): SeenResult | null {
  if (
    !isRecord(value)
    || typeof value.expectation !== "string"
    || typeof value.passed !== "boolean"
    || typeof value.evidence !== "string"
  ) return null;
  return { expectation: value.expectation, passed: value.passed, evidence: value.evidence };
}

function parseJudgment(value: unknown): RollJudgment | null {
  if (
    !isRecord(value)
    || typeof value.expectation !== "string"
    || (value.state !== "passed" && value.state !== "failed" && value.state !== "pending")
    || typeof value.reasoning !== "string"
  ) return null;
  return { expectation: value.expectation, state: value.state, reasoning: value.reasoning };
}

function judgmentForResult(result: SeenResult): RollJudgment {
  return {
    expectation: result.expectation,
    state: result.passed ? "passed" : "failed",
    reasoning: result.evidence,
  };
}

function parseFrame(value: unknown): RollFrame | null {
  if (
    !isRecord(value)
    || typeof value.caption !== "string"
    || typeof value.fileName !== "string"
    || typeof value.hash !== "string"
    || typeof value.route !== "string"
    || typeof value.at !== "string"
    || typeof value.description !== "string"
    || typeof value.model !== "string"
    || (value.ok !== null && typeof value.ok !== "boolean")
    || !Array.isArray(value.results)
  ) return null;
  const results: SeenResult[] = [];
  for (const result of value.results) {
    const parsed = parseResult(result);
    if (!parsed) return null;
    results.push(parsed);
  }
  const judgments: RollJudgment[] = [];
  if (Array.isArray(value.judgments)) {
    for (const judgment of value.judgments) {
      const parsed = parseJudgment(judgment);
      if (!parsed) return null;
      judgments.push(parsed);
    }
  } else {
    judgments.push(...results.map(judgmentForResult));
  }
  return {
    caption: value.caption,
    fileName: value.fileName,
    hash: value.hash,
    route: value.route,
    at: value.at,
    description: value.description,
    model: value.model,
    ok: value.ok,
    results,
    judgments,
  };
}

function parseRoll(value: unknown): RollRecord | null {
  if (
    !isRecord(value)
    || typeof value.name !== "string"
    || typeof value.dir !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.closedAt !== "string"
    || !Array.isArray(value.frames)
  ) return null;
  const frames: RollFrame[] = [];
  for (const frame of value.frames) {
    const parsed = parseFrame(frame);
    if (!parsed) return null;
    frames.push(parsed);
  }
  const gitSha = typeof value.gitSha === "string" ? value.gitSha : undefined;
  const branch = typeof value.branch === "string" ? value.branch : undefined;
  return {
    name: value.name,
    dir: value.dir,
    createdAt: value.createdAt,
    closedAt: value.closedAt,
    gitSha,
    branch,
    summary: summarize(frames),
    frames,
  };
}

function frameOk(judgments: RollJudgment[]): boolean | null {
  if (judgments.length === 0 || judgments.some((judgment) => judgment.state === "pending")) return null;
  return judgments.every((judgment) => judgment.state === "passed");
}

function resultForJudgment(judgment: RollJudgment): SeenResult[] {
  if (judgment.state === "pending") return [];
  return [{
    expectation: judgment.expectation,
    passed: judgment.state === "passed",
    evidence: judgment.reasoning,
  }];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function judgeRoll(rollDir: string, opts: JudgeRollOptions = {}): Promise<JudgeRollResult> {
  const rollPath = join(rollDir, "roll.json");
  const value: unknown = JSON.parse(await readFile(rollPath, "utf8"));
  const record = parseRoll(value);
  if (!record) throw new Error(`Invalid photo roll: ${rollPath}`);
  let touched = false;
  let judgedClaims = 0;
  const errors: string[] = [];

  for (const frame of record.frames) {
    if (!frame.fileName) continue;
    const targetIndexes = frame.judgments.flatMap((judgment, index) => (
      opts.force || judgment.state === "pending" ? [index] : []
    ));
    if (targetIndexes.length === 0) continue;
    touched = true;
    const expectations = targetIndexes.map((index) => frame.judgments[index].expectation);
    try {
      const png = await readFile(join(rollDir, frame.fileName));
      const facts = await judgeVision({
        png,
        hash: frame.hash,
        route: frame.route,
        visibleText: "",
        at: frame.at,
      }, expectations, { ask: opts.ask, bypassCache: opts.force });
      for (const [resultIndex, result] of facts.results.entries()) {
        const judgmentIndex = targetIndexes[resultIndex];
        frame.judgments[judgmentIndex] = {
          expectation: result.expectation,
          state: result.passed ? "passed" : "failed",
          reasoning: result.evidence,
        };
      }
      frame.description = facts.description;
      frame.model = facts.model;
      judgedClaims += targetIndexes.length;
    } catch (error) {
      const message = errorMessage(error);
      errors.push(`${frame.caption}: ${message}`);
      for (const index of targetIndexes) {
        const judgment = frame.judgments[index];
        frame.judgments[index] = { ...judgment, state: "pending", reasoning: `Provider error: ${message}` };
      }
    }
    frame.results = frame.judgments.flatMap(resultForJudgment);
    frame.ok = frameOk(frame.judgments);
  }

  record.summary = summarize(record.frames);
  if (touched) await writeRoll(record, rollDir);
  const visionJudgments = record.frames.filter((frame) => frame.fileName).flatMap((frame) => frame.judgments);
  return {
    rollPath,
    judgedClaims,
    failedClaims: visionJudgments.filter((judgment) => judgment.state === "failed").length,
    pendingClaims: visionJudgments.filter((judgment) => judgment.state === "pending").length,
    errors,
  };
}

export function openTape(meta: { name: string; outDir?: string }): Tape {
  const { name } = meta;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = meta.outDir ?? join(REPO_ROOT, "evals", "results", "rolls", `${stamp}-${slug(name)}`);
  const frames: StoredFrame[] = [];
  const createdAt = new Date().toISOString();
  const gitSha = gitValue(["HEAD"]);
  const branch = gitValue(["--abbrev-ref", "HEAD"]);
  let nextSequence = 1;
  let closing: Promise<string> | null = null;

  const assertOpen = (): void => {
    if (closing) throw new Error(`Cannot record evidence after tape "${name}" is closed.`);
  };

  const close = (): Promise<string> => {
    if (closing) return closing;
    closing = (async () => {
      await mkdir(dir, { recursive: true });
      for (const frame of frames) {
        if (frame.png) await writeFile(join(dir, frame.fileName), frame.png);
      }
      const orderedFrames = [
        ...frames.filter((frame) => frame.claimKey !== null),
        ...frames.filter((frame) => frame.claimKey === null),
      ].map(rollFrame);
      const record: RollRecord = {
        name,
        dir,
        createdAt,
        closedAt: new Date().toISOString(),
        gitSha,
        branch,
        summary: summarize(orderedFrames),
        frames: orderedFrames,
      };
      await writeRoll(record, dir);
      return join(dir, "index.html");
    })();
    return closing;
  };

  return {
    dir,
    recordTake(shot) {
      assertOpen();
      const sequence = nextSequence;
      nextSequence += 1;
      const caption = frameCaption(name, sequence);
      const takeFileName = fileName(sequence, caption);
      frames.push({
        caption,
        fileName: takeFileName,
        hash: shot.hash,
        route: shot.route,
        at: shot.at,
        description: "",
        model: "",
        ok: null,
        results: [],
        judgments: [],
        sequence,
        png: shot.png,
        claimKey: null,
      });
      return join(dir, takeFileName);
    },
    claim(shotHash, seen) {
      assertOpen();
      const key = claimKey(seen);
      const judgments = judgmentsForSeen(seen);
      const claimed = frames.find((frame) => frame.png !== null && frame.hash === shotHash && frame.claimKey !== null);
      if (claimed) {
        const caption = frameCaption(name, claimed.sequence, seen);
        if (claimed.claimKey !== key) {
          throw new Error(`Screenshot pixels for "${caption}" already back the different claim "${claimed.caption}".`);
        }
        claimed.caption = caption;
        claimed.fileName = fileName(claimed.sequence, caption);
        claimed.description = seen.description;
        claimed.model = seen.model;
        claimed.ok = seen.deferred ? null : seen.ok;
        claimed.results = seen.results;
        claimed.judgments = judgments;
        return join(dir, claimed.fileName);
      }
      const take = frames.find((frame) => frame.png !== null && frame.hash === shotHash && frame.claimKey === null);
      if (!take) throw new Error(`No recorded take has screenshot hash "${shotHash}".`);
      const caption = frameCaption(name, take.sequence, seen);
      take.caption = caption;
      take.fileName = fileName(take.sequence, caption);
      take.description = seen.description;
      take.model = seen.model;
      take.ok = seen.deferred ? null : seen.ok;
      take.results = seen.results;
      take.judgments = judgments;
      take.claimKey = key;
      return join(dir, take.fileName);
    },
    fact(claim, evidence, passed) {
      assertOpen();
      const sequence = nextSequence;
      nextSequence += 1;
      const caption = claim.trim() || `${name} fact ${sequence}`;
      frames.push({
        caption,
        fileName: "",
        hash: "",
        route: "",
        at: new Date().toISOString(),
        description: evidence,
        model: "",
        ok: passed,
        results: [{ expectation: caption, evidence, passed }],
        judgments: [{ expectation: caption, state: passed ? "passed" : "failed", reasoning: evidence }],
        sequence,
        png: null,
        claimKey: JSON.stringify([caption]),
      });
    },
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
}
