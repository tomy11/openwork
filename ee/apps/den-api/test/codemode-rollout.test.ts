import { describe, expect, test } from "bun:test"
import { codemodeScriptsEnabled } from "../src/capability-sources/codemode-rollout.js"

describe("codemodeScriptsEnabled", () => {
  test("is enabled only by a literal nested capability true", () => {
    expect(codemodeScriptsEnabled({ capabilities: { codemodeScripts: true } })).toBe(true)
    expect(codemodeScriptsEnabled(JSON.stringify({ capabilities: { codemodeScripts: true } }))).toBe(true)
  })

  test("is disabled for absent, false, legacy flat, malformed, and non-boolean values", () => {
    for (const metadata of [
      null,
      undefined,
      {},
      { capabilities: { codemodeScripts: false } },
      { codemodeScripts: true },
      "not json",
      "true",
      '{"capabilities":{"codemodeScripts":true}',
      JSON.stringify({ codemodeScripts: true }),
      JSON.stringify({ capabilities: { codemodeScripts: "true" } }),
    ]) {
      expect(codemodeScriptsEnabled(metadata)).toBe(false)
    }
  })
})
