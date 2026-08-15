import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect } from "vitest";
import { briefTest, claim, createBriefRun, specBrief, test } from "@openwork/testkit";

const rollDirs: string[] = [];
let recordedDir = "";

function readEvidenceDir(evidence: unknown): string {
  if (typeof evidence !== "object" || evidence === null || !("dir" in evidence) || typeof evidence.dir !== "string") {
    throw new Error("Testkit evidence fixture did not expose a directory.");
  }
  return evidence.dir;
}

afterAll(async () => {
  await Promise.all(rollDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

briefTest(specBrief({
  behavior: "A spec brief requires and records explicit proof for every declared claim.",
  claims: {
    claimRegistered: claim("declared claims expose matching proof functions", { never: "omit a declared proof entry" }),
    factsRecorded: claim("successful proof calls become passed ambient tape facts", { never: "leave successful claims unrecorded" }),
  },
}), ({ prove, evidence }) => {
  recordedDir = readEvidenceDir(evidence);
  rollDirs.push(recordedDir);
  expect(Object.keys(prove)).toEqual(["claimRegistered", "factsRecorded"]);

  const missingRun = createBriefRun(specBrief({ behavior: "Missing proof fails.", claims: { missing: claim("is required") } }), () => {});
  expect(() => missingRun.assertAllProven()).toThrow("Brief claims left unproven: missing");

  const failedRecords: { passed: boolean; evidence: string }[] = [];
  const failedRun = createBriefRun(specBrief({ behavior: "Failed proof records.", claims: { failed: claim("must pass") } }), (_claimText, proofEvidence, passed) => {
    failedRecords.push({ passed, evidence: proofEvidence });
  });
  expect(() => failedRun.prove.failed(false, "the injected recorder observed the failed proof")).toThrow("Claim failed: failed");
  expect(failedRecords).toEqual([{ passed: false, evidence: "the injected recorder observed the failed proof" }]);

  prove.claimRegistered(true, "Object.keys(prove) matched both declared claim keys");
  prove.factsRecorded(true, "both successful prove calls completed against the ambient test tape");
});

test("brief facts are persisted on the preceding test tape", async ({ evidence }) => {
  rollDirs.push(evidence.dir);
  const value: unknown = JSON.parse(await readFile(join(recordedDir, "roll.json"), "utf8"));
  expect(value).toMatchObject({
    summary: {
      ok: true,
      totalFrames: 2,
      passedFrames: 2,
      passedExpectations: 2,
      failedExpectations: 0,
    },
    frames: [
      {
        caption: "claimRegistered: declared claims expose matching proof functions — never: omit a declared proof entry",
        ok: true,
        description: "Object.keys(prove) matched both declared claim keys",
        judgments: [{ state: "passed", reasoning: "Object.keys(prove) matched both declared claim keys" }],
      },
      {
        caption: "factsRecorded: successful proof calls become passed ambient tape facts — never: leave successful claims unrecorded",
        ok: true,
        description: "both successful prove calls completed against the ambient test tape",
        judgments: [{ state: "passed", reasoning: "both successful prove calls completed against the ambient test tape" }],
      },
    ],
  });
});
