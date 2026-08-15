type MetadataInput = Record<string, unknown> | string | null | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseMetadata(input: MetadataInput): Record<string, unknown> {
  if (!input) return {}
  if (typeof input !== "string") return isRecord(input) ? input : {}
  try {
    const parsed: unknown = JSON.parse(input)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function codemodeScriptsEnabled(metadata: MetadataInput): boolean {
  const parsed = parseMetadata(metadata)
  const capabilities = isRecord(parsed.capabilities) ? parsed.capabilities : {}
  return capabilities.codemodeScripts === true
}
