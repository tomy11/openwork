import type { SavedScriptVersion } from "@openwork/types/dynamic-artifacts"

export function redactSavedScriptNormalizedPayloadAuthoringDetails(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return null
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "exampleInput"))
}

export function redactSavedScriptVersionAuthoringDetails(
  version: SavedScriptVersion,
): SavedScriptVersion {
  return {
    ...version,
    code: null,
    exampleInput: null,
    automationReferences: version.automationReferences.map((reference) => ({
      id: reference.id,
      name: reference.name,
      state: reference.state,
      configObjectVersionId: reference.configObjectVersionId,
    })),
  }
}
