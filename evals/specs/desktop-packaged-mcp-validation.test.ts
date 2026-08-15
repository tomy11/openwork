import { expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "@openwork/testkit";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the packaged Desktop runtime can load MCP validation and SSE transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "openwork-mcp-validation-"));
  try {
    const nodeModules = join(root, "node_modules");
    const prepare = spawnSync(process.execPath, [
      resolve(repoRoot, "apps/desktop/scripts/prepare-runtime-node-modules.mjs"),
      "--outdir",
      nodeModules,
    ], { encoding: "utf8" });
    expect(prepare.status, prepare.stderr).toBe(0);

    const sdkRoot = join(nodeModules, "@modelcontextprotocol", "sdk");
    const provider = await import(`${pathToFileURL(join(sdkRoot, "dist", "esm", "validation", "ajv-provider.js")).href}?test=${Date.now()}`);
    const validator = new provider.AjvJsonSchemaValidator().getValidator({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    });
    expect(validator({ title: "Artifact" })).toMatchObject({ valid: true });
    expect(validator({ title: 42 })).toMatchObject({ valid: false });

    const sse = await import(`${pathToFileURL(join(sdkRoot, "dist", "esm", "client", "sse.js")).href}?test=${Date.now()}`);
    expect(sse.SSEClientTransport).toBeTypeOf("function");

    expect(JSON.parse(readFileSync(join(nodeModules, "ajv", "package.json"), "utf8")).name).toBe("ajv");
    expect(JSON.parse(readFileSync(join(nodeModules, "eventsource", "package.json"), "utf8")).name).toBe("eventsource");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
