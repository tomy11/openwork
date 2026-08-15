import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECT_MCP_SERVER_INDEX_URI,
  connectMcpRuntimeName,
  readOpenWorkConnectMcpServerIndex,
  reconcileOpenWorkConnectMcpServers,
} from "./connect-mcp-server-catalog.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;

afterEach(async () => {
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
});

async function fixtureConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "openwork-connect-mcp-servers-"));
  roots.push(root);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test",
    hostToken: "host",
    configPath: join(root, "openwork.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "One", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

function indexFetcher(requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>) {
  return async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, headers: new Headers(init?.headers), body });
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { resources: {} } } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: {
        contents: [{
          uri: CONNECT_MCP_SERVER_INDEX_URI,
          mimeType: "application/json",
          text: JSON.stringify({
            schemaVersion: "openwork.connect/mcp-servers/1",
            servers: [{
              connectionId: "emc_01k28e8q8pf8r9sff9mhyqxved",
              name: "Project Atlas",
              description: null,
              url: "https://cloud.example/mcp/agent/connections/emc_01k28e8q8pf8r9sff9mhyqxved",
            }],
          }),
        }],
      },
    });
  };
}

describe("OpenWork Connect MCP server catalog", () => {
  test("reads the member catalog through an authenticated MCP resource", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const index = await readOpenWorkConnectMcpServerIndex({
      type: "remote",
      url: "https://cloud.example/mcp/agent",
      headers: { Authorization: "Bearer member-token" },
    }, indexFetcher(requests));

    expect(index?.servers[0]?.name).toBe("Project Atlas");
    expect(requests.map((request) => request.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "resources/read",
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer member-token")).toBe(true);
  });

  test("reconciles only OpenWork-owned proxy entries and preserves user MCPs", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "openwork-connect-stale": { type: "remote", url: "https://cloud.example/stale" },
      },
    }));
    const connectionId = "emc_01k28e8q8pf8r9sff9mhyqxved";
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: {
        type: "remote",
        url: "https://cloud.example/mcp/agent",
        headers: { Authorization: "Bearer member-token" },
      },
      fetcher: indexFetcher([]),
    });

    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(result).toEqual({
      status: "synced",
      names: [connectMcpRuntimeName(connectionId)],
      removedNames: ["openwork-connect-stale"],
    });
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
    expect(runtime.mcp?.["openwork-connect-stale"]).toBeUndefined();
    expect(runtime.mcp?.[connectMcpRuntimeName(connectionId)]).toEqual({
      type: "remote",
      url: `https://cloud.example/mcp/agent/connections/${connectionId}`,
      enabled: true,
      headers: { Authorization: "Bearer member-token" },
    });
  });

  test("leaves prior entries untouched when an older Cloud server has no index", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: { "openwork-connect-existing": { type: "remote", url: "https://cloud.example/existing" } },
    }));
    const result = await reconcileOpenWorkConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://cloud.example/mcp/agent" },
      fetcher: async () => new Response(null, { status: 404 }),
    });
    expect(result).toEqual({ status: "unavailable", names: [], removedNames: [] });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["openwork-connect-existing"]).toBeTruthy();
  });
});
