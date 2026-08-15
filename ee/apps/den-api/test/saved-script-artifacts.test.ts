import assert from "node:assert/strict"
import test from "node:test"
import {
  artifactDigest,
  artifactFreshness,
  canonicalArtifactJson,
  renderSavedScriptMarkdown,
  savedScriptArtifactSource,
} from "../src/saved-script-artifacts.js"
import { recordCodemodeRun } from "../src/codemode-runs.js"
import {
  redactSavedScriptNormalizedPayloadAuthoringDetails,
  redactSavedScriptVersionAuthoringDetails,
} from "../src/saved-script-projections.js"

test("canonical JSON and digests are stable across object key order", () => {
  assert.equal(canonicalArtifactJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}')
  assert.equal(artifactDigest({ b: 2, a: 1 }), artifactDigest({ a: 1, b: 2 }))
})

test("durable receipts keep only the input digest", async () => {
  let stored: Record<string, unknown> | null = null
  const database = {
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        stored = value
      },
    }),
  }
  const inputDigest = artifactDigest({ token: "api-secret" })

  const receiptId = await recordCodemodeRun(database as never, {
    organizationId: "org_test" as never,
    source: "saved-script-test",
    code: "return input",
    status: "succeeded",
    toolCalls: [],
    durationMs: 1,
    startedAt: new Date("2026-08-10T12:00:00.000Z"),
    finishedAt: new Date("2026-08-10T12:00:00.001Z"),
    scriptInputDigest: inputDigest,
    // Prove an unexpected legacy caller cannot make the raw value durable.
    scriptInput: { token: "api-secret" },
  } as never)

  assert.ok(receiptId)
  assert.ok(stored)
  assert.equal(stored.script_input, null)
  assert.equal(stored.script_input_digest, inputDigest)
  assert.equal(JSON.stringify(stored).includes("api-secret"), false)
})

test("viewer and editor projections omit manager-only Script authoring data", () => {
  const projected = redactSavedScriptVersionAuthoringDetails({
    id: "cov_test",
    code: "return input.token",
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
    exampleInput: { token: "authoring-secret" },
    requiredCapabilities: [],
    codeDigest: `sha256:${"a".repeat(64)}`,
    inputSchemaDigest: null,
    outputSchemaDigest: null,
    createdAt: "2026-08-13T12:00:00.000Z",
    automationReferences: [{
      id: "aut_test",
      name: "Private input automation",
      state: "active",
      configObjectVersionId: "cov_test",
      input: { token: "automation-secret" },
    }],
  })

  assert.equal(projected.code, null)
  assert.equal(projected.exampleInput, null)
  assert.equal("input" in projected.automationReferences[0]!, false)
  assert.equal(JSON.stringify(projected).includes("authoring-secret"), false)
  assert.equal(JSON.stringify(projected).includes("automation-secret"), false)
})

test("generic config-object projections omit saved Script example input", () => {
  const projected = redactSavedScriptNormalizedPayloadAuthoringDetails({
    language: "codemode-js",
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
    exampleInput: { token: "authoring-secret" },
    requiredCapabilities: [],
  })

  assert.deepEqual(projected, {
    language: "codemode-js",
    inputSchema: { type: "object" },
    outputSchema: { type: "string" },
    requiredCapabilities: [],
  })
  assert.equal(JSON.stringify(projected).includes("authoring-secret"), false)
})

test("Markdown rendering is deterministic and never emits raw HTML", () => {
  assert.equal(renderSavedScriptMarkdown("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;")
  assert.equal(renderSavedScriptMarkdown({ b: true, a: "<strong>x</strong>" }), [
    "| Key | Value |",
    "| --- | --- |",
    "| a | &lt;strong&gt;x&lt;/strong&gt; |",
    "| b | true |",
  ].join("\n"))
  assert.equal(renderSavedScriptMarkdown([{ b: 2, a: 1 }, { a: 3, b: 4 }]), [
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "| 3 | 4 |",
  ].join("\n"))
  assert.equal(renderSavedScriptMarkdown({ nested: { value: 1 } }), '```json\n{"nested":{"value":1}}\n```')
  assert.equal(renderSavedScriptMarkdown({ path: String.raw`C:\reports\a|b` }), [
    "| Key | Value |",
    "| --- | --- |",
    String.raw`| path | C:\\reports\\a\|b |`,
  ].join("\n"))
})

test("freshness preserves last-good state after failures", () => {
  const now = new Date("2026-08-10T12:00:00.000Z")
  assert.deepEqual(artifactFreshness({
    latestFinishedAt: null,
    latestStatus: null,
    latestSuccessfulFinishedAt: null,
    latestSuccessfulReceiptId: null,
    maxAgeMs: 60_000,
    now,
  }), { state: "never_run" })
  assert.deepEqual(artifactFreshness({
    latestFinishedAt: new Date("2026-08-10T11:59:30.000Z"),
    latestStatus: "failed",
    latestSuccessfulFinishedAt: new Date("2026-08-10T11:58:00.000Z"),
    latestSuccessfulReceiptId: "cmr_last_good",
    maxAgeMs: 60_000,
    now,
    failureReason: "Provider access was revoked.",
  }), {
    state: "needs_attention",
    ageMs: 120_000,
    lastSuccessfulReceiptId: "cmr_last_good",
    reason: "Provider access was revoked.",
  })
  assert.deepEqual(artifactFreshness({
    latestFinishedAt: new Date("2026-08-10T11:59:30.000Z"),
    latestStatus: "succeeded",
    latestSuccessfulFinishedAt: new Date("2026-08-10T11:59:30.000Z"),
    latestSuccessfulReceiptId: "cmr_fresh",
    maxAgeMs: 60_000,
    now,
  }), { state: "fresh", ageMs: 30_000 })
  assert.deepEqual(artifactFreshness({
    latestFinishedAt: new Date("2026-08-10T11:58:00.000Z"),
    latestStatus: "succeeded",
    latestSuccessfulFinishedAt: new Date("2026-08-10T11:58:00.000Z"),
    latestSuccessfulReceiptId: "cmr_stale",
    maxAgeMs: 60_000,
    now,
  }), { state: "stale", ageMs: 120_000, maxAgeMs: 60_000 })
})

test("recovery-triggered Automation artifacts keep scheduled lineage", () => {
  assert.equal(savedScriptArtifactSource("scheduled"), "scheduled")
  assert.equal(savedScriptArtifactSource("recovery"), "scheduled")
  assert.equal(savedScriptArtifactSource("manual"), "manual")
  assert.equal(savedScriptArtifactSource(null), "manual")
})
