import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { withTape } from "../src/ambient.ts";
import { judgeRoll, openTape } from "../src/tape.ts";
import { validate } from "../src/validate.ts";
import type { VisionRequest } from "../src/validate.ts";
import type { Shot } from "../src/screenshot.ts";

function testShot(hash: string): Shot {
  return {
    png: Buffer.from("canned png"),
    hash,
    route: "#/workspace/ws_test/session",
    visibleText: "OpenWork composer",
    at: "2026-07-29T12:00:00.000Z",
  };
}

test("validate describes, matches, computes failure facts, and caches", async () => {
  const unique = randomUUID();
  const expectations = [`Composer is visible ${unique}`, `No error is visible ${unique}`];
  const requests: VisionRequest[] = [];
  const ask = async (request: VisionRequest): Promise<string> => {
    requests.push(request);
    if (requests.length === 1) return JSON.stringify({ description: "A composer and an error banner are visible." });
    return JSON.stringify({
      results: [
        { expectation: expectations[0], passed: true, evidence: "The composer is centered on screen." },
        { expectation: expectations[1], passed: false, evidence: "An error banner is visible." },
      ],
    });
  };

  const first = await validate(testShot(unique), expectations, { ask });
  assert.equal(first.cached, false);
  assert.equal(first.ok, false);
  assert.equal(first.description, "A composer and an error banner are visible.");
  assert.equal(first.results[0]?.passed, true);
  assert.equal(first.results[1]?.passed, false);
  assert.match(first.why, /No error is visible/);
  assert.match(first.why, /An error banner is visible/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.prompt.includes(unique), false, "description request must not know the expectations");
  assert.equal(requests[1]?.prompt.includes(unique), true);

  const second = await validate(testShot(unique), expectations, { ask });
  assert.equal(second.cached, true);
  assert.equal(second.ok, false);
  assert.equal(requests.length, 2, "cache hit must not call the transport");
});

test("validate rejects malformed model verdicts clearly", async () => {
  let calls = 0;
  const ask = async (): Promise<string> => {
    calls += 1;
    return calls === 1 ? JSON.stringify({ description: "A visible app window." }) : "not-json";
  };
  await assert.rejects(
    () => validate(testShot(randomUUID()), [`Visible app ${randomUUID()}`], { ask }),
    /Vision model verdict response was not valid JSON/,
  );
});

test("defer mode judges a caller-provided deterministic witness inline", async () => {
  const previousMode = process.env.OPENWORK_EVAL_VISION;
  try {
    process.env.OPENWORK_EVAL_VISION = "defer";
    const expectation = `Synthetic frame is visible ${randomUUID()}`;
    let calls = 0;
    const facts = await validate(testShot(randomUUID()), [expectation], {
      bypassCache: true,
      ask: async () => {
        calls += 1;
        return calls === 1
          ? JSON.stringify({ description: "A synthetic frame is visible." })
          : JSON.stringify({ results: [{ expectation, passed: false, evidence: "The expected detail is absent." }] });
      },
    });

    assert.equal(facts.ok, false);
    assert.equal(facts.results[0]?.passed, false);
    assert.equal(facts.deferred, undefined);
    assert.equal(calls, 2);
  } finally {
    if (previousMode === undefined) delete process.env.OPENWORK_EVAL_VISION;
    else process.env.OPENWORK_EVAL_VISION = previousMode;
  }
});

test("deferred validation records pending claims that the judge resolves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-deferred-vision-"));
  const previousMode = process.env.OPENWORK_EVAL_VISION;
  try {
    const expectation = `Synthetic frame is visible ${randomUUID()}`;
    const shot = testShot(randomUUID());
    const tape = openTape({ name: "deferred vision", outDir: dir });
    tape.recordTake(shot);
    process.env.OPENWORK_EVAL_VISION = "defer";
    const deferred = await withTape(tape, () => validate(shot, [expectation], { bypassCache: true }));
    assert.equal(deferred.ok, true);
    assert.equal(deferred.deferred, true);
    assert.equal(deferred.why, "vision judgment deferred");
    await tape.close();

    const pendingRoll = await readFile(join(dir, "roll.json"), "utf8");
    assert.match(pendingRoll, /"state": "pending"/);
    assert.match(pendingRoll, /"pendingFrames": 1/);
    assert.match(pendingRoll, /"pendingJudgments": 1/);

    const providerError = await judgeRoll(dir, {
      ask: async () => {
        throw new Error("stub provider unavailable");
      },
    });
    assert.equal(providerError.judgedClaims, 0);
    assert.equal(providerError.pendingClaims, 1);
    assert.match(providerError.errors[0], /stub provider unavailable/);

    const requests: VisionRequest[] = [];
    const judged = await judgeRoll(dir, {
      ask: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? JSON.stringify({ description: "A synthetic frame is visible." })
          : JSON.stringify({ results: [{ expectation, passed: true, evidence: "The synthetic frame is present." }] });
      },
    });
    assert.equal(judged.judgedClaims, 1);
    assert.equal(judged.failedClaims, 0);
    assert.equal(judged.pendingClaims, 0);
    assert.equal(requests.length, 2);

    const resolvedRoll = await readFile(join(dir, "roll.json"), "utf8");
    assert.match(resolvedRoll, /"state": "passed"/);
    assert.match(resolvedRoll, /"reasoning": "The synthetic frame is present\."/);
    assert.match(resolvedRoll, /"pendingJudgments": 0/);

    let idempotentCalls = 0;
    const unchanged = await judgeRoll(dir, {
      ask: async () => {
        idempotentCalls += 1;
        throw new Error("resolved claims must not be re-judged");
      },
    });
    assert.equal(unchanged.judgedClaims, 0);
    assert.equal(unchanged.failedClaims, 0);
    assert.equal(idempotentCalls, 0);

    const cli = spawnSync(process.execPath, [
      fileURLToPath(new URL("../bin/judge.mjs", import.meta.url)),
      "--roll",
      dir,
    ], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Judged 0 claim\(s\): 0 failed, 0 pending\./);

    let forcedCalls = 0;
    const forced = await judgeRoll(dir, {
      force: true,
      ask: async (request) => {
        forcedCalls += 1;
        return forcedCalls === 1
          ? JSON.stringify({ description: "A synthetic frame is visible." })
          : JSON.stringify({ results: [{ expectation, passed: false, evidence: "The expected detail is absent." }] });
      },
    });
    assert.equal(forced.judgedClaims, 1);
    assert.equal(forced.failedClaims, 1);
    assert.equal(forced.pendingClaims, 0);
    assert.equal(forcedCalls, 2, "--force must bypass the cached judgment");
  } finally {
    if (previousMode === undefined) delete process.env.OPENWORK_EVAL_VISION;
    else process.env.OPENWORK_EVAL_VISION = previousMode;
    await rm(dir, { recursive: true, force: true });
  }
});
