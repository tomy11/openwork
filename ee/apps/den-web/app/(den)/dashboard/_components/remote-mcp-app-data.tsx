"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { libraryQueryKeys } from "./library-data";

export type RemoteMcpAppDocumentMetadata = {
  name: string;
  version: string;
  description?: string;
  launchTool?: { title?: string; description?: string };
};

export type RemoteMcpAppRevision = {
  id: string;
  active: boolean;
  createdAt: string;
  createdByOrgMembershipId: string | null;
  metadata: RemoteMcpAppDocumentMetadata;
  source: { url: string; resolvedUrl: string; fetchedAt: string; contentType: string | null };
  resource: {
    byteSize: number;
    digest: string;
    csp: { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[]; baseUriDomains: string[] };
  };
  diagnostics: string[];
  resourceUri: string;
};

export type RemoteMcpApp = {
  id: string;
  pluginId: string;
  status: "active" | "retired";
  sourceUrl: string;
  resolvedSourceUrl: string;
  activeVersionId: string | null;
  activeRevision: RemoteMcpAppRevision | null;
  latestRevision: RemoteMcpAppRevision | null;
  revisions: RemoteMcpAppRevision[];
  role: "viewer" | "editor" | "manager";
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
};

export type RemoteMcpAppPreview = {
  metadata: RemoteMcpAppDocumentMetadata;
  sourceUrl: string;
  resolvedSourceUrl: string;
  resource: RemoteMcpAppRevision["resource"];
  diagnostics: string[];
};

export const remoteMcpAppQueryKeys = {
  detail: (appId: string) => ["remote-mcp-apps", appId] as const,
};

function itemFromPayload(payload: unknown): RemoteMcpApp {
  if (!payload || typeof payload !== "object" || !("item" in payload)) {
    throw new Error("Remote MCP App response was incomplete.");
  }
  return (payload as { item: RemoteMcpApp }).item;
}

async function appRequest(path: string, init?: RequestInit) {
  const { response, payload } = await requestJson(path, init, 30000);
  if (!response.ok) throw getRequestError(payload, response, `Remote MCP App request failed (${response.status}).`);
  return itemFromPayload(payload);
}

export function usePreviewRemoteMcpApp() {
  return useMutation({
    mutationFn: async (sourceUrl: string): Promise<RemoteMcpAppPreview> => {
      const { response, payload } = await requestJson("/v1/remote-mcp-apps/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceUrl }),
      }, 30000);
      if (!response.ok) throw getRequestError(payload, response, `App preview failed (${response.status}).`);
      return (payload as { preview: RemoteMcpAppPreview }).preview;
    },
  });
}

export function useImportRemoteMcpApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sourceUrl: string }) => appRequest("/v1/remote-mcp-apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, activate: true }),
    }),
    onSuccess: async (app) => {
      queryClient.setQueryData(remoteMcpAppQueryKeys.detail(app.id), app);
      await queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items });
    },
  });
}

export function useRemoteMcpApp(appId: string) {
  return useQuery({
    queryKey: remoteMcpAppQueryKeys.detail(appId),
    queryFn: () => appRequest(`/v1/remote-mcp-apps/${encodeURIComponent(appId)}`),
  });
}

function useAppMutation(
  appId: string,
  request: (input: unknown) => Promise<RemoteMcpApp>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async (app) => {
      queryClient.setQueryData(remoteMcpAppQueryKeys.detail(appId), app);
      await queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items });
    },
  });
}

export function useRefreshRemoteMcpApp(appId: string) {
  return useAppMutation(appId, (input) => {
    const body = input as { sourceUrl?: string };
    return appRequest(`/v1/remote-mcp-apps/${encodeURIComponent(appId)}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  });
}

export function useActivateRemoteMcpApp(appId: string) {
  return useAppMutation(appId, (input) => appRequest(`/v1/remote-mcp-apps/${encodeURIComponent(appId)}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export function useRemoteMcpAppLifecycle(appId: string) {
  return useAppMutation(appId, (input) => appRequest(`/v1/remote-mcp-apps/${encodeURIComponent(appId)}/lifecycle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function downloadRemoteMcpAppRevision(appId: string, versionId: string, fileName: string) {
  const { response, payload, text } = await requestJson(
    `/v1/remote-mcp-apps/${encodeURIComponent(appId)}/revisions/${encodeURIComponent(versionId)}/download`,
    {},
    30000,
  );
  if (!response.ok) {
    throw getRequestError(payload, response, `App download failed (${response.status}).`);
  }
  const objectUrl = URL.createObjectURL(new Blob([text], {
    type: response.headers.get("content-type") ?? "text/html;charset=utf-8",
  }));
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}
