"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  savedScriptArtifactSnapshotSchema,
  savedScriptDetailSchema,
  savedScriptTestResultSchema,
  type SavedScriptCapability,
} from "@openwork/types/dynamic-artifacts";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";

export type SavedScriptDraft = {
  name: string;
  description?: string;
  code: string;
  exampleInput?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  requiredCapabilities: SavedScriptCapability[];
};

const keys = {
  detail: (id: string, maxAgeMs: number) => ["saved-script", id, "detail", maxAgeMs] as const,
  snapshots: (id: string) => ["saved-script", id, "snapshots"] as const,
};

async function checkedRequest(path: string, init: RequestInit, fallback: string) {
  const { response, payload } = await requestJson(path, init, 170_000);
  if (!response.ok) throw new Error(getErrorMessage(payload, `${fallback} (${response.status}).`));
  return payload;
}

export function useSavedScriptDetail(configObjectId: string, maxAgeMs: number) {
  return useQuery({
    queryKey: keys.detail(configObjectId, maxAgeMs),
    queryFn: async () => savedScriptDetailSchema.parse(await checkedRequest(
      `/v1/codemode-scripts/${encodeURIComponent(configObjectId)}?maxAgeMs=${maxAgeMs}`,
      { method: "GET" },
      "Failed to load Script",
    )),
    enabled: Boolean(configObjectId),
  });
}

export function useSavedScriptSnapshots(configObjectId: string) {
  return useQuery({
    queryKey: keys.snapshots(configObjectId),
    queryFn: async () => {
      const payload = await checkedRequest(
        `/v1/codemode-scripts/${encodeURIComponent(configObjectId)}/snapshots?limit=100`,
        { method: "GET" },
        "Failed to load snapshots",
      );
      if (typeof payload !== "object" || payload === null || !("items" in payload) || !Array.isArray(payload.items)) {
        throw new Error("The snapshot response was invalid.");
      }
      return payload.items.map((item) => savedScriptArtifactSnapshotSchema.parse(item));
    },
    enabled: Boolean(configObjectId),
  });
}

function useLifecycleMutation<TInput, TResult>(input: {
  configObjectId: string;
  mutation: (value: TInput) => Promise<TResult>;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: input.mutation,
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["saved-script", input.configObjectId] });
      await queryClient.invalidateQueries({ queryKey: ["plugins"] });
      await queryClient.invalidateQueries({ queryKey: ["automations"] });
    },
  });
}

export function useTestSavedScript(configObjectId: string) {
  return useLifecycleMutation<SavedScriptDraft, ReturnType<typeof savedScriptTestResultSchema.parse>>({
    configObjectId,
    mutation: async (draft) => savedScriptTestResultSchema.parse(await checkedRequest(
      "/v1/codemode-scripts/test",
      { method: "POST", body: JSON.stringify({ configObjectId, ...draft }) },
      "Script test failed",
    )),
  });
}

export function useSaveSavedScriptVersion(configObjectId: string) {
  return useLifecycleMutation<{ receiptId: string; draft: SavedScriptDraft }, ReturnType<typeof savedScriptDetailSchema.parse>>({
    configObjectId,
    mutation: async ({ receiptId, draft }) => savedScriptDetailSchema.parse(await checkedRequest(
      `/v1/codemode-scripts/${encodeURIComponent(configObjectId)}/versions`,
      { method: "POST", body: JSON.stringify({ receiptId, ...draft }) },
      "Script version could not be saved",
    )),
  });
}

export function useRunSavedScript(configObjectId: string) {
  return useLifecycleMutation<{ pluginId: string; configObjectVersionId: string; input: unknown }, unknown>({
    configObjectId,
    mutation: async (value) => checkedRequest(
      `/v1/codemode-scripts/${encodeURIComponent(configObjectId)}/run`,
      { method: "POST", body: JSON.stringify(value) },
      "Script refresh failed",
    ),
  });
}

export function useDeleteSavedScriptSnapshot(configObjectId: string) {
  return useLifecycleMutation<string, unknown>({
    configObjectId,
    mutation: async (receiptId) => checkedRequest(
      `/v1/codemode-scripts/${encodeURIComponent(configObjectId)}/snapshots/${encodeURIComponent(receiptId)}/content`,
      { method: "DELETE" },
      "Snapshot content could not be deleted",
    ),
  });
}

export function useUpdateSavedScriptAutomation(configObjectId: string) {
  return useLifecycleMutation<{
    automationId: string;
    pluginId: string;
    configObjectVersionId: string;
    input: unknown;
  }, unknown>({
    configObjectId,
    mutation: async (value) => checkedRequest(
      `/v1/automations/${encodeURIComponent(value.automationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          action: {
            kind: "saved_script",
            script: {
              pluginId: value.pluginId,
              configObjectId,
              configObjectVersionId: value.configObjectVersionId,
            },
            input: value.input,
          },
          executionTarget: "cloud",
        }),
      },
      "Automation could not be updated",
    ),
  });
}
