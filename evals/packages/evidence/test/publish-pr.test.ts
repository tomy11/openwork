import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishPr } from "../src/publish-pr.ts";
import type { CommandRunner, Fetcher } from "../src/publish-pr.ts";
import type { PhotoRollRecord } from "../src/schema.ts";

function dryRunRecord(dir: string): PhotoRollRecord {
  return {
    name: "Dry run proof",
    dir,
    createdAt: "2026-07-02T10:00:00.000Z",
    closedAt: "2026-07-02T10:01:00.000Z",
    summary: {
      ok: true,
      totalFrames: 1,
      passedFrames: 1,
      failedFrames: 0,
      unvalidatedFrames: 0,
      passedExpectations: 1,
      failedExpectations: 0,
    },
    frames: [{
      caption: "Dry-run claim",
      fileName: "01-dry-run.png",
      hash: "hash",
      route: "#/dry-run",
      at: "2026-07-02T10:00:00.000Z",
      description: "Visible dry-run state",
      model: "test-model",
      ok: true,
      results: [{ expectation: "Dry run is visible", passed: true, evidence: "Visible" }],
    }],
  };
}

test("publishPr dry-run prints composed markdown without upload or gh calls", async () => {
  const rollDir = await mkdtemp(join(tmpdir(), "openwork-evidence-publish-"));
  try {
    await mkdir(rollDir, { recursive: true });
    await writeFile(join(rollDir, "roll.json"), JSON.stringify(dryRunRecord(rollDir)));
    let commandCalled = false;
    let fetchCalled = false;
    let output = "";
    const exec: CommandRunner = () => {
      commandCalled = true;
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const fetcher: Fetcher = async () => {
      fetchCalled = true;
      throw new Error("unexpected fetch");
    };
    const result = await publishPr(
      { rollDir, dryRun: true },
      { exec, fetch: fetcher, stdout: (markdown) => { output = markdown; } },
    );
    assert.equal(commandCalled, false);
    assert.equal(fetchCalled, false);
    assert.equal(result.posted, false);
    assert.match(output, /<!-- photo-roll -->/);
    assert.match(output, /Dry-run claim/);
    assert.match(output, /Dry run: screenshots were not uploaded/);
  } finally {
    await rm(rollDir, { recursive: true, force: true });
  }
});

test("publishPr refuses a symlinked frame before calling the blob uploader", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-evidence-symlink-frame-"));
  const rollDir = join(root, "roll");
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await mkdir(rollDir);
    await writeFile(join(rollDir, "roll.json"), JSON.stringify(dryRunRecord(rollDir)));
    const outsideFile = join(root, "private-key");
    await writeFile(outsideFile, "private material");
    await symlink(outsideFile, join(rollDir, "01-dry-run.png"));
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    let fetchCalled = false;
    const fetcher: Fetcher = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ url: "https://example.test/unexpected.png" }));
    };
    const exec: CommandRunner = () => ({ status: 0, stdout: "", stderr: "" });
    await assert.rejects(
      () => publishPr({ pr: 17, rollDir }, { exec, fetch: fetcher }),
      /Refusing to upload non-regular or symlinked roll frame: 01-dry-run\.png/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("publishPr uploads a regular frame and posts the composed comment", async () => {
  const rollDir = await mkdtemp(join(tmpdir(), "openwork-evidence-regular-frame-"));
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await writeFile(join(rollDir, "roll.json"), JSON.stringify(dryRunRecord(rollDir)));
    await writeFile(join(rollDir, "01-dry-run.png"), Buffer.from("regular png"));
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    let fetchCalls = 0;
    const fetcher: Fetcher = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ url: "https://example.test/regular.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const exec: CommandRunner = (_command, args) => ({
      status: 0,
      stdout: args.includes("view") ? JSON.stringify({ comments: [] }) : "posted",
      stderr: "",
    });
    const result = await publishPr({ pr: 17, rollDir }, { exec, fetch: fetcher });
    assert.equal(fetchCalls, 1);
    assert.equal(result.posted, true);
    assert.equal(result.updated, false);
    assert.equal(result.urls["01-dry-run.png"], "https://example.test/regular.png");
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await rm(rollDir, { recursive: true, force: true });
  }
});
