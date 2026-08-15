import { createHash } from "node:crypto";
import { z } from "zod";

import { readMcpResourceText, type McpFetch } from "./connect-mcp-transport.js";
import { runtimeMcpMap, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { externalFetch } from "./server-fetch.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export const CONNECT_MCP_SERVER_INDEX_URI = "openwork://connect/mcp-servers/index.json";
export const CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION = "openwork.connect/mcp-servers/1";
export const CONNECT_MCP_SERVER_NAME_PREFIX = "openwork-connect-";

const indexSchema = z.object({
  schemaVersion: z.literal(CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION),
  servers: z.array(z.object({
    connectionId: z.string().min(1).max(160),
    name: z.string().min(1).max(255),
    description: z.string().max(1_024).nullable(),
    url: z.string().url().refine((value) => /^https?:\/\//.test(value), "MCP server URL must use HTTP(S)"),
  })).max(100),
});

export type OpenWorkConnectMcpServerIndex = z.infer<typeof indexSchema>;

export function connectMcpRuntimeName(connectionId: string): string {
  const digest = createHash("sha256").update(connectionId).digest("hex").slice(0, 12);
  return `${CONNECT_MCP_SERVER_NAME_PREFIX}${digest}`;
}

export async function readOpenWorkConnectMcpServerIndex(
  cloudMcp: Record<string, unknown>,
  fetcher: McpFetch = externalFetch,
): Promise<OpenWorkConnectMcpServerIndex | null> {
  const text = await readMcpResourceText({
    config: cloudMcp,
    uri: CONNECT_MCP_SERVER_INDEX_URI,
    fetcher,
    clientName: "openwork-server-connect-mcp-catalog",
  });
  if (text === null) return null;
  const parsed = indexSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : null;
}

/**
 * Reconciles only OpenWork-owned Connect proxy entries. User-authored MCP
 * configurations are never touched. A missing/unreadable index is a no-op so
 * an older Cloud deployment cannot erase a previously working catalog.
 */
export async function reconcileOpenWorkConnectMcpServers(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  cloudMcp: Record<string, unknown>;
  fetcher?: McpFetch;
}): Promise<{ status: "synced" | "unavailable"; names: string[]; removedNames: string[] }> {
  const index = await readOpenWorkConnectMcpServerIndex(input.cloudMcp, input.fetcher);
  if (!index) return { status: "unavailable", names: [], removedNames: [] };

  const headers = typeof input.cloudMcp.headers === "object" && input.cloudMcp.headers !== null
    ? input.cloudMcp.headers
    : undefined;
  const entries = Object.fromEntries(index.servers.map((server) => {
    const name = connectMcpRuntimeName(server.connectionId);
    return [name, {
      type: "remote",
      url: server.url,
      enabled: input.cloudMcp.enabled !== false,
      ...(headers ? { headers } : {}),
    }];
  }));
  let removedNames: string[] = [];
  await writeRuntimeOpencodeConfig(input.config, input.workspace.id, (current) => {
    const currentMcp = runtimeMcpMap(current);
    removedNames = Object.keys(currentMcp)
      .filter((name) => name.startsWith(CONNECT_MCP_SERVER_NAME_PREFIX) && !(name in entries))
      .sort();
    return {
      ...current,
      mcp: {
        ...Object.fromEntries(Object.entries(currentMcp)
          .filter(([name]) => !name.startsWith(CONNECT_MCP_SERVER_NAME_PREFIX))),
        ...entries,
      },
    };
  });
  return { status: "synced", names: Object.keys(entries).sort(), removedNames };
}
