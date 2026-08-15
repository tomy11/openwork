"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  generatedArtifactViewSchema,
  savedScriptDetailSchema,
  type GeneratedArtifactView,
  type SavedScriptDetail,
} from "@openwork/types/dynamic-artifacts";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";

type ProgramSummary = {
  type: "program"; id: string; plugin: { id: string; name: string } | null; name: string; description: string | null;
  role: "viewer" | "editor" | "manager"; state: "ready" | "needs_signin" | "needs_admin_setup";
  resultState: "never_run" | "fresh" | "stale" | "needs_attention"; latestSuccessfulAt: string | null;
  viewState: "default" | "custom_active" | "build_failed" | "retired"; activeViewTitle: string | null;
  automationCount: number; source: { kind: "created" | "installed_template" };
};
export type ProgramDetail = { program: ProgramSummary; script: SavedScriptDetail; views: GeneratedArtifactView[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseProgramDetail(value: unknown): ProgramDetail {
  if (!isRecord(value) || !isRecord(value.program) || !Array.isArray(value.views)) throw new Error("Program response was incomplete.");
  const program = value.program;
  const role = program.role === "viewer" || program.role === "editor" || program.role === "manager" ? program.role : null;
  const state = program.state === "ready" || program.state === "needs_signin" || program.state === "needs_admin_setup" ? program.state : null;
  const resultState = program.resultState === "never_run" || program.resultState === "fresh" || program.resultState === "stale" || program.resultState === "needs_attention" ? program.resultState : null;
  const viewState = program.viewState === "default" || program.viewState === "custom_active" || program.viewState === "build_failed" || program.viewState === "retired" ? program.viewState : null;
  const sourceKind = isRecord(program.source) && (program.source.kind === "created" || program.source.kind === "installed_template") ? program.source.kind : null;
  const plugin = isRecord(program.plugin) && typeof program.plugin.id === "string" && typeof program.plugin.name === "string" ? { id: program.plugin.id, name: program.plugin.name } : null;
  if (program.type !== "program" || typeof program.id !== "string" || (program.plugin !== null && !plugin) || typeof program.name !== "string" || !role || !state || !resultState || !viewState || !sourceKind || typeof program.automationCount !== "number") {
    throw new Error("Program response was incomplete.");
  }
  return {
    program: {
      type: "program", id: program.id, plugin, name: program.name,
      description: typeof program.description === "string" ? program.description : null,
      role, state, resultState,
      latestSuccessfulAt: typeof program.latestSuccessfulAt === "string" ? program.latestSuccessfulAt : null,
      viewState, activeViewTitle: typeof program.activeViewTitle === "string" ? program.activeViewTitle : null,
      automationCount: program.automationCount, source: { kind: sourceKind },
    },
    script: savedScriptDetailSchema.parse(value.script),
    views: value.views.map((view) => generatedArtifactViewSchema.parse(view)),
  };
}

async function mutationJson(path: string, method: "POST" | "PUT") {
  const { response, payload } = await requestJson(path, { method }, 15_000);
  if (!response.ok) throw new Error(getErrorMessage(payload, `Program action failed (${response.status}).`));
  return payload;
}

export function useProgramDetail(programId: string) {
  return useQuery({
    queryKey: ["program", programId],
    queryFn: async () => {
      const { response, payload } = await requestJson(`/v1/programs/${encodeURIComponent(programId)}`, { method: "GET" }, 15_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Failed to load Program (${response.status}).`));
      return parseProgramDetail(payload);
    },
  });
}

export function useActivateArtifactView(programId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ viewId, revisionId }: { viewId: string; revisionId: string }) => generatedArtifactViewSchema.parse(await mutationJson(
      `/v1/artifact-views/${encodeURIComponent(viewId)}/revisions/${encodeURIComponent(revisionId)}/activate`,
      "POST",
    )),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["program", programId] }),
  });
}

export function useRetireArtifactView(programId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (viewId: string) => generatedArtifactViewSchema.parse(await mutationJson(
      `/v1/artifact-views/${encodeURIComponent(viewId)}/retire`,
      "POST",
    )),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["program", programId] }),
  });
}

export function useSelectProgram() {
  return useMutation({
    mutationFn: async (programId: string) => {
      const { response, payload } = await requestJson("/v1/me/program-selection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ programId }),
      }, 15_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Failed to select Program (${response.status}).`));
      return payload;
    },
  });
}
