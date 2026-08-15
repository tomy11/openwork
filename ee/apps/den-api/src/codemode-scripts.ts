import type {
  AutomationAction,
} from "@openwork/types/automations"
import type {
  SavedScriptArtifactSnapshot,
  SavedScriptDetail,
  SavedScriptVersion,
} from "@openwork/types/dynamic-artifacts"
import { and, asc, desc, eq, gt, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AutomationRevisionTable,
  AutomationRunTable,
  AutomationTable,
  CodemodeRunTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MemberTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
  TeamMemberTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { codemodeCodeDigest } from "./codemode-runs.js"
import { db } from "./db.js"
import { parseCodemodeScriptPayload, validateCodemodeScriptInput } from "./mcp/codemode-script-object.js"
import type { BuiltCodemodeTools } from "./mcp/codemode-tools.js"
import { executeSavedCodemodeScript } from "./mcp/saved-codemode-script-service.js"
import {
  artifactDigest,
  artifactFreshness,
  optionalArtifactDigest,
  savedScriptArtifactSource,
  SAVED_SCRIPT_MARKDOWN_RENDERER_VERSION,
} from "./saved-script-artifacts.js"
import { redactSavedScriptVersionAuthoringDetails } from "./saved-script-projections.js"
import {
  requirePluginArchResourceRole,
  resolvePluginArchGrantRole,
  resolvePluginArchResourceRole,
  type PluginArchActorContext,
} from "./routes/org/plugin-system/access.js"
import { memberHasRole } from "./routes/org/shared.js"

const DEFAULT_PROGRAMS_PLUGIN_NAME = "My Programs"
const LEGACY_SAVED_SCRIPTS_PLUGIN_NAME = "Saved scripts"
const RECENT_RUN_WINDOW_MS = 15 * 60_000

export type SaveCodemodeScriptInput = {
  pluginId?: string
  name: string
  description?: string
  code: string
  currentInput?: unknown
  inputSchema?: unknown
  outputSchema?: unknown
}

export type CodemodeScriptDraft = SaveCodemodeScriptInput & {
  exampleInput?: unknown
  requiredCapabilities: Array<{ capabilityName: string; scriptPath: string }>
}

type CodemodeRunRow = typeof CodemodeRunTable.$inferSelect
type AutomationRunTrigger = typeof AutomationRunTable.$inferSelect.trigger
type ConfigObjectId = DenTypeId<"configObject">

function parseConfigObjectId(value: string): ConfigObjectId {
  return normalizeDenTypeId("configObject", value)
}

function parseReceiptId(value: string): DenTypeId<"codemodeRun"> {
  return normalizeDenTypeId("codemodeRun", value)
}

async function savedScriptResource(
  context: PluginArchActorContext,
  value: string,
  role: "viewer" | "manager",
) {
  const configObjectId = parseConfigObjectId(value)
  const rows = await db.select({ configObject: ConfigObjectTable, plugin: PluginTable })
    .from(ConfigObjectTable)
    .innerJoin(PluginConfigObjectTable, and(
      eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
      isNull(PluginConfigObjectTable.removedAt),
    ))
    .innerJoin(PluginTable, and(
      eq(PluginTable.id, PluginConfigObjectTable.pluginId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))
    .where(and(
      eq(ConfigObjectTable.id, configObjectId),
      eq(ConfigObjectTable.organizationId, context.organizationContext.organization.id),
      eq(ConfigObjectTable.objectType, "script"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))
    // A Program may be assigned to more than one Plugin. Keep memberships in
    // a stable order so the first one visible to this member becomes the
    // execution/provenance context.
    .orderBy(asc(PluginConfigObjectTable.createdAt), asc(PluginConfigObjectTable.id))
  if (!rows[0]) throw new Error("saved_script_not_found")
  await requirePluginArchResourceRole({
    context,
    requireFreshSession: false,
    resourceId: configObjectId,
    resourceKind: "config_object",
    role,
  })
  for (const row of rows) {
    const pluginRole = await resolvePluginArchResourceRole({
      context,
      resourceId: row.plugin.id,
      resourceKind: "plugin",
    })
    if (pluginRole) return row
  }
  // Direct Program grants are intentionally independent from Plugin access.
  // In that case retain the deterministic oldest membership as its execution
  // context; capability execution separately enforces the Program grant.
  return rows[0]
}

function normalizedPayload(draft: CodemodeScriptDraft) {
  const value = {
    language: "codemode-js",
    ...(draft.inputSchema === undefined ? {} : { inputSchema: draft.inputSchema }),
    ...(draft.outputSchema === undefined ? {} : { outputSchema: draft.outputSchema }),
    ...(draft.exampleInput === undefined ? {} : { exampleInput: draft.exampleInput }),
    requiredCapabilities: draft.requiredCapabilities,
  }
  const parsed = parseCodemodeScriptPayload(value)
  if (!parsed.ok) throw new Error(`saved_script_invalid_schema:${parsed.message}`)
  return { parsed: parsed.payload, value }
}

function draftReceiptSource(configObjectId: ConfigObjectId, draft: CodemodeScriptDraft) {
  return `saved-script-test:${configObjectId}:${artifactDigest({
    name: draft.name.trim(),
    description: draft.description?.trim() || null,
    requiredCapabilities: draft.requiredCapabilities,
  })}`
}

function serializeSnapshot(row: CodemodeRunRow, automationTrigger: AutomationRunTrigger | null): SavedScriptArtifactSnapshot | null {
  if (!row.plugin_id || !row.config_object_id || !row.config_object_version_id) return null
  const deleted = row.artifact_content_deleted_at !== null
  return {
    receiptId: row.id,
    pluginId: row.plugin_id,
    configObjectId: row.config_object_id,
    configObjectVersionId: row.config_object_version_id,
    automationRunId: row.automation_run_id,
    value: deleted ? null : row.validated_result ?? null,
    markdown: deleted ? null : row.result_markdown,
    codeDigest: row.code_digest,
    resultDigest: row.result_digest,
    inputSchemaDigest: row.input_schema_digest,
    outputSchemaDigest: row.output_schema_digest,
    rendererVersion: row.renderer_version === SAVED_SCRIPT_MARKDOWN_RENDERER_VERSION
      ? SAVED_SCRIPT_MARKDOWN_RENDERER_VERSION
      : null,
    status: row.status,
    errorKind: row.error_kind,
    errorMessage: row.error_message,
    source: savedScriptArtifactSource(automationTrigger),
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString(),
    contentDeletedAt: row.artifact_content_deleted_at?.toISOString() ?? null,
  }
}

async function currentAutomationReferences(context: PluginArchActorContext, configObjectId: ConfigObjectId) {
  const rows = await db.select({ automation: AutomationTable, revision: AutomationRevisionTable })
    .from(AutomationTable)
    .innerJoin(AutomationRevisionTable, eq(AutomationRevisionTable.id, AutomationTable.current_revision_id))
    .where(and(
      eq(AutomationTable.organization_id, context.organizationContext.organization.id),
      eq(AutomationTable.owner_member_id, context.organizationContext.currentMember.id),
    ))
  return rows.flatMap(({ automation, revision }) => {
    const action = revision.action
    if (action?.kind !== "saved_script" || action.script.configObjectId !== configObjectId) return []
    return [{
      id: automation.id,
      name: automation.name,
      state: automation.state,
      configObjectVersionId: action.script.configObjectVersionId,
      input: action.input,
    }]
  })
}

async function savedScriptVersions(
  context: PluginArchActorContext,
  configObjectId: ConfigObjectId,
  includeAuthoringDetails: boolean,
): Promise<SavedScriptVersion[]> {
  const [rows, automationReferences] = await Promise.all([
    db.select().from(ConfigObjectVersionTable).where(and(
      eq(ConfigObjectVersionTable.organizationId, context.organizationContext.organization.id),
      eq(ConfigObjectVersionTable.configObjectId, configObjectId),
      eq(ConfigObjectVersionTable.isDeletedVersion, false),
    )).orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id)),
    currentAutomationReferences(context, configObjectId),
  ])
  return rows.flatMap((row) => {
    const parsed = parseCodemodeScriptPayload(row.normalizedPayloadJson)
    if (!parsed.ok) return []
    const code = row.rawSourceText ?? ""
    const version: SavedScriptVersion = {
      id: row.id,
      code,
      inputSchema: parsed.payload.inputSchema ?? null,
      outputSchema: parsed.payload.outputSchema ?? null,
      exampleInput: parsed.payload.exampleInput ?? null,
      requiredCapabilities: parsed.payload.requiredCapabilities,
      codeDigest: codemodeCodeDigest(code),
      inputSchemaDigest: optionalArtifactDigest(parsed.payload.inputSchema),
      outputSchemaDigest: optionalArtifactDigest(parsed.payload.outputSchema),
      createdAt: row.createdAt.toISOString(),
      automationReferences: automationReferences.filter((reference) => reference.configObjectVersionId === row.id),
    }
    return [includeAuthoringDetails ? version : redactSavedScriptVersionAuthoringDetails(version)]
  })
}

async function snapshotRows(organizationId: DenTypeId<"organization">, configObjectId: ConfigObjectId, limit = 100) {
  return db.select({ receipt: CodemodeRunTable, automationTrigger: AutomationRunTable.trigger })
    .from(CodemodeRunTable)
    .leftJoin(AutomationRunTable, eq(AutomationRunTable.id, CodemodeRunTable.automation_run_id))
    .where(and(
    eq(CodemodeRunTable.organization_id, organizationId),
    eq(CodemodeRunTable.config_object_id, configObjectId),
    isNotNull(CodemodeRunTable.config_object_version_id),
  )).orderBy(desc(CodemodeRunTable.finished_at), desc(CodemodeRunTable.id)).limit(limit)
}

export async function getCodemodeScriptDetail(input: {
  context: PluginArchActorContext
  configObjectId: string
  maxAgeMs?: number
}): Promise<SavedScriptDetail> {
  const resource = await savedScriptResource(input.context, input.configObjectId, "viewer")
  const role = await resolvePluginArchResourceRole({
    context: input.context,
    resourceId: resource.configObject.id,
    resourceKind: "config_object",
  })
  const [versions, rows] = await Promise.all([
    savedScriptVersions(input.context, resource.configObject.id, role === "manager"),
    snapshotRows(resource.configObject.organizationId, resource.configObject.id),
  ])
  const currentVersion = versions[0]
  if (!currentVersion) throw new Error("saved_script_version_not_found")
  const snapshots = rows.flatMap((row) => {
    const snapshot = serializeSnapshot(row.receipt, row.automationTrigger)
    return snapshot ? [snapshot] : []
  })
  // Deleted content remains in history, but must not stay selected as the
  // current readable artifact after an explicit deletion.
  const latestSnapshot = snapshots.find((snapshot) => snapshot.contentDeletedAt === null)
    ?? snapshots[0]
    ?? null
  const latestSuccessfulSnapshot = snapshots.find((snapshot) => snapshot.status === "succeeded" && snapshot.markdown !== null) ?? null
  return {
    pluginId: resource.plugin.id,
    configObjectId: resource.configObject.id,
    title: resource.configObject.title,
    description: resource.configObject.description,
    canRun: role === "editor" || role === "manager",
    canManage: role === "manager",
    currentVersion,
    versions,
    latestSnapshot,
    latestSuccessfulSnapshot,
    freshness: artifactFreshness({
      latestFinishedAt: latestSnapshot?.contentDeletedAt === null ? new Date(latestSnapshot.finishedAt) : null,
      latestStatus: latestSnapshot?.contentDeletedAt === null ? latestSnapshot.status : null,
      latestSuccessfulFinishedAt: latestSuccessfulSnapshot ? new Date(latestSuccessfulSnapshot.finishedAt) : null,
      latestSuccessfulReceiptId: latestSuccessfulSnapshot?.receiptId ?? null,
      failureReason: latestSnapshot?.errorMessage,
      maxAgeMs: Math.min(30 * 24 * 60 * 60_000, Math.max(60_000, input.maxAgeMs ?? 24 * 60 * 60_000)),
    }),
  }
}

export async function listCodemodeScriptVersions(input: { context: PluginArchActorContext; configObjectId: string }) {
  const resource = await savedScriptResource(input.context, input.configObjectId, "viewer")
  const role = await resolvePluginArchResourceRole({
    context: input.context,
    resourceId: resource.configObject.id,
    resourceKind: "config_object",
  })
  return savedScriptVersions(input.context, resource.configObject.id, role === "manager")
}

export async function listCodemodeScriptSnapshots(input: {
  context: PluginArchActorContext
  configObjectId: string
  limit?: number
}) {
  const resource = await savedScriptResource(input.context, input.configObjectId, "viewer")
  const rows = await snapshotRows(resource.configObject.organizationId, resource.configObject.id, input.limit)
  return rows.flatMap((row) => {
    const snapshot = serializeSnapshot(row.receipt, row.automationTrigger)
    return snapshot ? [snapshot] : []
  })
}

export async function getCodemodeScriptSnapshot(input: {
  context: PluginArchActorContext
  configObjectId: string
  receiptId: string
}) {
  const resource = await savedScriptResource(input.context, input.configObjectId, "viewer")
  const rows = await db.select({ receipt: CodemodeRunTable, automationTrigger: AutomationRunTable.trigger })
    .from(CodemodeRunTable)
    .leftJoin(AutomationRunTable, eq(AutomationRunTable.id, CodemodeRunTable.automation_run_id))
    .where(and(
    eq(CodemodeRunTable.id, parseReceiptId(input.receiptId)),
    eq(CodemodeRunTable.organization_id, resource.configObject.organizationId),
    eq(CodemodeRunTable.config_object_id, resource.configObject.id),
    isNotNull(CodemodeRunTable.config_object_version_id),
  )).limit(1)
  return rows[0] ? serializeSnapshot(rows[0].receipt, rows[0].automationTrigger) : null
}

export async function testCodemodeScriptDraft(input: {
  context: PluginArchActorContext
  configObjectId: string
  draft: CodemodeScriptDraft
  buildTools: () => Promise<BuiltCodemodeTools>
}) {
  const resource = await savedScriptResource(input.context, input.configObjectId, "manager")
  const payload = normalizedPayload(input.draft)
  const execution = await executeSavedCodemodeScript({
    database: db,
    organizationId: resource.configObject.organizationId,
    orgMembershipId: input.context.organizationContext.currentMember.id,
    pluginId: resource.plugin.id,
    configObjectId: resource.configObject.id,
    normalizedPayloadJson: payload.value,
    code: input.draft.code,
    receiptSource: draftReceiptSource(resource.configObject.id, input.draft),
    scriptInput: input.draft.exampleInput,
    validateOutput: true,
    buildTools: input.buildTools,
  })
  if (!execution.ok) return execution
  if (!execution.receiptId) throw new Error("saved_script_test_receipt_not_durable")
  return {
    ...execution,
    finishedAt: new Date().toISOString(),
    requiredCapabilities: payload.parsed.requiredCapabilities,
  }
}

export async function createCodemodeScriptVersion(input: {
  context: PluginArchActorContext
  configObjectId: string
  receiptId: string
  draft: CodemodeScriptDraft
  buildTools: () => Promise<BuiltCodemodeTools>
}) {
  const resource = await savedScriptResource(input.context, input.configObjectId, "manager")
  const payload = normalizedPayload(input.draft)
  if (payload.parsed.inputSchema) {
    const validation = validateCodemodeScriptInput(payload.parsed.inputSchema, input.draft.exampleInput)
    if (!validation.ok) throw new Error("saved_script_current_input_invalid")
  }
  const codeDigest = codemodeCodeDigest(input.draft.code)
  const scriptInputDigest = artifactDigest(input.draft.exampleInput ?? null)
  const inputSchemaDigest = optionalArtifactDigest(payload.parsed.inputSchema)
  const outputSchemaDigest = optionalArtifactDigest(payload.parsed.outputSchema)
  const receipts = await db.select().from(CodemodeRunTable).where(and(
    eq(CodemodeRunTable.id, parseReceiptId(input.receiptId)),
    eq(CodemodeRunTable.organization_id, resource.configObject.organizationId),
    eq(CodemodeRunTable.org_membership_id, input.context.organizationContext.currentMember.id),
    eq(CodemodeRunTable.plugin_id, resource.plugin.id),
    eq(CodemodeRunTable.config_object_id, resource.configObject.id),
    isNull(CodemodeRunTable.config_object_version_id),
    eq(CodemodeRunTable.source, draftReceiptSource(resource.configObject.id, input.draft)),
    eq(CodemodeRunTable.code_digest, codeDigest),
    eq(CodemodeRunTable.script_input_digest, scriptInputDigest),
    inputSchemaDigest === null
      ? isNull(CodemodeRunTable.input_schema_digest)
      : eq(CodemodeRunTable.input_schema_digest, inputSchemaDigest),
    outputSchemaDigest === null
      ? isNull(CodemodeRunTable.output_schema_digest)
      : eq(CodemodeRunTable.output_schema_digest, outputSchemaDigest),
    eq(CodemodeRunTable.status, "succeeded"),
    isNull(CodemodeRunTable.artifact_content_deleted_at),
    gt(CodemodeRunTable.finished_at, new Date(Date.now() - RECENT_RUN_WINDOW_MS)),
  )).limit(1)
  const receipt = receipts[0]
  if (!receipt || receipt.renderer_version !== SAVED_SCRIPT_MARKDOWN_RENDERER_VERSION
    || receipt.result_markdown === null || receipt.result_digest === null) {
    throw new Error("saved_script_matching_test_receipt_required")
  }

  const consumed = await db.select({ id: ConfigObjectVersionTable.id }).from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.organizationId, resource.configObject.organizationId),
    eq(ConfigObjectVersionTable.configObjectId, resource.configObject.id),
    eq(ConfigObjectVersionTable.sourceRevisionRef, receipt.id),
  )).limit(1)
  if (consumed[0]) throw new Error("saved_script_test_receipt_already_used")

  const built = await input.buildTools()
  const manifestByPath = new Map(built.manifest.flatMap((entry) => [
    [entry.scriptPath, entry] as const,
    [entry.scriptPath.replace(/^tools\./, ""), entry] as const,
  ]))
  for (const required of payload.parsed.requiredCapabilities) {
    const current = manifestByPath.get(required.scriptPath)
    if (!current || current.capabilityName !== required.capabilityName) {
      throw new Error(`saved_script_capability_unavailable:${required.scriptPath}`)
    }
    if (current.readOnly !== true) throw new Error(`saved_script_requires_read_only_capabilities:${required.scriptPath}`)
  }
  for (const call of receipt.tool_calls ?? []) {
    if (!payload.parsed.requiredCapabilities.some((required) => {
      const normalized = call.name.replace(/^tools\./, "")
      return required.scriptPath === call.name || required.scriptPath.replace(/^tools\./, "") === normalized
    })) throw new Error(`saved_script_test_capability_mismatch:${call.name}`)
  }

  const now = new Date()
  const configObjectVersionId = createDenTypeId("configObjectVersion")
  await db.transaction(async (tx) => {
    await tx.insert(ConfigObjectVersionTable).values({
      id: configObjectVersionId,
      organizationId: resource.configObject.organizationId,
      configObjectId: resource.configObject.id,
      normalizedPayloadJson: payload.value,
      rawSourceText: input.draft.code,
      schemaVersion: "codemode-script-v1",
      createdVia: "cloud",
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      sourceRevisionRef: receipt.id,
      isDeletedVersion: false,
      createdAt: now,
    })
    await tx.update(ConfigObjectTable).set({
      title: input.draft.name,
      description: input.draft.description?.trim() || null,
      searchText: `${input.draft.name} ${input.draft.description ?? ""}`.trim(),
      currentFileName: `${input.draft.name}.js`,
      updatedAt: now,
    }).where(eq(ConfigObjectTable.id, resource.configObject.id))
  })
  return getCodemodeScriptDetail({ context: input.context, configObjectId: resource.configObject.id })
}

export async function deleteCodemodeScriptSnapshotContent(input: {
  context: PluginArchActorContext
  configObjectId: string
  receiptId: string
}) {
  const resource = await savedScriptResource(input.context, input.configObjectId, "manager")
  const receiptId = parseReceiptId(input.receiptId)
  const rows = await db.select().from(CodemodeRunTable).where(and(
    eq(CodemodeRunTable.id, receiptId),
    eq(CodemodeRunTable.organization_id, resource.configObject.organizationId),
    eq(CodemodeRunTable.config_object_id, resource.configObject.id),
    isNotNull(CodemodeRunTable.config_object_version_id),
  )).limit(1)
  const receipt = rows[0]
  if (!receipt) throw new Error("saved_script_snapshot_not_found")
  if (!receipt.artifact_content_deleted_at) {
    await db.update(CodemodeRunTable).set({
      script_input: null,
      validated_result: null,
      result_markdown: null,
      artifact_content_deleted_at: new Date(),
    }).where(eq(CodemodeRunTable.id, receipt.id))
  }

  if (receipt.automation_run_id) {
    const automationRuns = await db.select({ automationId: AutomationRunTable.automation_id })
      .from(AutomationRunTable)
      .where(eq(AutomationRunTable.id, receipt.automation_run_id)).limit(1)
    const automationId = automationRuns[0]?.automationId
    if (automationId) {
      const retained = await db.select({ receipt: CodemodeRunTable, run: AutomationRunTable })
        .from(CodemodeRunTable)
        .innerJoin(AutomationRunTable, eq(AutomationRunTable.id, CodemodeRunTable.automation_run_id))
        .where(and(
          eq(AutomationRunTable.automation_id, automationId),
          eq(CodemodeRunTable.config_object_id, resource.configObject.id),
          eq(CodemodeRunTable.status, "succeeded"),
          isNull(CodemodeRunTable.artifact_content_deleted_at),
          isNotNull(CodemodeRunTable.result_markdown),
        )).orderBy(desc(CodemodeRunTable.finished_at), desc(CodemodeRunTable.id)).limit(1)
      await db.update(AutomationTable).set({
        latest_successful_run_id: retained[0]?.run.id ?? null,
        latest_successful_result: retained[0]?.receipt.validated_result ?? null,
      }).where(eq(AutomationTable.id, automationId))
    }
  }
  return getCodemodeScriptSnapshot({ ...input, receiptId })
}

export async function validateSavedScriptAutomationAction(input: {
  organizationId: string
  ownerMemberId: string
  action: Extract<AutomationAction, { kind: "saved_script" }>
}) {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const ownerMemberId = normalizeDenTypeId("member", input.ownerMemberId)
  const pluginId = normalizeDenTypeId("plugin", input.action.script.pluginId)
  const configObjectId = normalizeDenTypeId("configObject", input.action.script.configObjectId)
  const configObjectVersionId = normalizeDenTypeId("configObjectVersion", input.action.script.configObjectVersionId)
  const members = await db.select({ role: MemberTable.role }).from(MemberTable).where(and(
    eq(MemberTable.id, ownerMemberId),
    eq(MemberTable.organizationId, organizationId),
    isNull(MemberTable.removedAt),
  )).limit(1)
  const member = members[0]
  if (!member) throw new Error("automation_owner_inactive")
  if (!memberHasRole(member.role, "admin")) {
    const [teams, configObjectGrants, pluginGrants] = await Promise.all([
      db.select({ id: TeamMemberTable.teamId }).from(TeamMemberTable)
        .where(eq(TeamMemberTable.orgMembershipId, ownerMemberId)),
      db.select({
        orgMembershipId: ConfigObjectAccessGrantTable.orgMembershipId,
        orgWide: ConfigObjectAccessGrantTable.orgWide,
        removedAt: ConfigObjectAccessGrantTable.removedAt,
        role: ConfigObjectAccessGrantTable.role,
        teamId: ConfigObjectAccessGrantTable.teamId,
      }).from(ConfigObjectAccessGrantTable).where(and(
        eq(ConfigObjectAccessGrantTable.organizationId, organizationId),
        eq(ConfigObjectAccessGrantTable.configObjectId, configObjectId),
      )),
      db.select({
        orgMembershipId: PluginAccessGrantTable.orgMembershipId,
        orgWide: PluginAccessGrantTable.orgWide,
        removedAt: PluginAccessGrantTable.removedAt,
        role: PluginAccessGrantTable.role,
        teamId: PluginAccessGrantTable.teamId,
      }).from(PluginAccessGrantTable).where(and(
        eq(PluginAccessGrantTable.organizationId, organizationId),
        eq(PluginAccessGrantTable.pluginId, pluginId),
      )),
    ])
    const grantInput = { memberId: ownerMemberId, teamIds: teams.map((team) => team.id) }
    if (!resolvePluginArchGrantRole({ ...grantInput, grants: configObjectGrants })
      && !resolvePluginArchGrantRole({ ...grantInput, grants: pluginGrants })) {
      throw new Error("automation_saved_script_forbidden")
    }
  }
  const rows = await db.select({ version: ConfigObjectVersionTable })
    .from(ConfigObjectVersionTable)
    .innerJoin(ConfigObjectTable, and(
      eq(ConfigObjectTable.id, ConfigObjectVersionTable.configObjectId),
      eq(ConfigObjectTable.organizationId, organizationId),
      eq(ConfigObjectTable.objectType, "script"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))
    .innerJoin(PluginConfigObjectTable, and(
      eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
      eq(PluginConfigObjectTable.pluginId, pluginId),
      isNull(PluginConfigObjectTable.removedAt),
    ))
    .where(and(
      eq(ConfigObjectVersionTable.id, configObjectVersionId),
      eq(ConfigObjectVersionTable.configObjectId, configObjectId),
      eq(ConfigObjectVersionTable.organizationId, organizationId),
      eq(ConfigObjectVersionTable.isDeletedVersion, false),
    )).limit(1)
  const version = rows[0]?.version
  if (!version) throw new Error("automation_saved_script_version_not_found")
  const parsed = parseCodemodeScriptPayload(version.normalizedPayloadJson)
  if (!parsed.ok) throw new Error("automation_saved_script_version_invalid")
  if (parsed.payload.inputSchema) {
    const validation = validateCodemodeScriptInput(parsed.payload.inputSchema, input.action.input)
    if (!validation.ok) throw new Error("automation_saved_script_input_invalid")
  }
}

export async function saveCodemodeScript(input: {
  organizationId: string
  ownerMemberId: string
  script: SaveCodemodeScriptInput
  buildTools: () => Promise<BuiltCodemodeTools>
  context?: PluginArchActorContext
}): Promise<{ pluginId: string; configObjectId: string; configObjectVersionId: string }> {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const ownerMemberId = normalizeDenTypeId("member", input.ownerMemberId)
  const requestedPluginId = input.script.pluginId
    ? normalizeDenTypeId("plugin", input.script.pluginId)
    : null
  if (requestedPluginId) {
    if (
      !input.context
      || input.context.organizationContext.organization.id !== organizationId
      || input.context.organizationContext.currentMember.id !== ownerMemberId
    ) {
      throw new Error("saved_program_plugin_context_required")
    }
    await requirePluginArchResourceRole({
      context: input.context,
      resourceId: requestedPluginId,
      resourceKind: "plugin",
      role: "editor",
    })
  }
  const receipts = await db.select().from(CodemodeRunTable).where(and(
    eq(CodemodeRunTable.organization_id, organizationId),
    eq(CodemodeRunTable.org_membership_id, ownerMemberId),
    eq(CodemodeRunTable.code_digest, codemodeCodeDigest(input.script.code)),
    eq(CodemodeRunTable.status, "succeeded"),
    gt(CodemodeRunTable.finished_at, new Date(Date.now() - RECENT_RUN_WINDOW_MS)),
  )).orderBy(desc(CodemodeRunTable.finished_at)).limit(1)
  const receipt = receipts[0]
  if (!receipt) throw new Error("saved_script_recent_receipt_required")

  const built = await input.buildTools()
  const manifestByPath = new Map(built.manifest.flatMap((entry) => [
    [entry.scriptPath, entry] as const,
    [entry.scriptPath.replace(/^tools\./, ""), entry] as const,
  ]))
  const requiredCapabilities: Array<{ capabilityName: string; scriptPath: string }> = []
  for (const call of receipt.tool_calls ?? []) {
    const resolved = manifestByPath.get(call.name)
    if (!resolved) throw new Error(`saved_script_capability_unavailable:${call.name}`)
    if (resolved.readOnly !== true) throw new Error(`saved_script_requires_read_only_capabilities:${call.name}`)
    if (!requiredCapabilities.some((entry) => entry.scriptPath === resolved.scriptPath)) {
      requiredCapabilities.push({
        capabilityName: resolved.capabilityName,
        scriptPath: resolved.scriptPath,
      })
    }
  }
  const normalizedPayloadJson = {
    language: "codemode-js",
    ...(input.script.inputSchema === undefined ? {} : { inputSchema: input.script.inputSchema }),
    ...(input.script.outputSchema === undefined ? {} : { outputSchema: input.script.outputSchema }),
    ...(input.script.currentInput === undefined ? {} : { exampleInput: input.script.currentInput }),
    requiredCapabilities,
  }
  const parsed = parseCodemodeScriptPayload(normalizedPayloadJson)
  if (!parsed.ok) throw new Error(`saved_script_invalid_schema:${parsed.message}`)
  if (parsed.payload.inputSchema) {
    const validation = validateCodemodeScriptInput(parsed.payload.inputSchema, input.script.currentInput)
    if (!validation.ok) throw new Error("saved_script_current_input_invalid")
  }

  return db.transaction(async (tx) => {
    const plugins = requestedPluginId
      ? await tx.select().from(PluginTable).where(and(
          eq(PluginTable.id, requestedPluginId),
          eq(PluginTable.organizationId, organizationId),
          eq(PluginTable.status, "active"),
          isNull(PluginTable.deletedAt),
        )).limit(1).for("update")
      : await tx.select().from(PluginTable).where(and(
          eq(PluginTable.organizationId, organizationId),
          eq(PluginTable.createdByOrgMembershipId, ownerMemberId),
          eq(PluginTable.name, DEFAULT_PROGRAMS_PLUGIN_NAME),
          eq(PluginTable.status, "active"),
          isNull(PluginTable.deletedAt),
        )).limit(1).for("update")
    const legacyPlugins = requestedPluginId || plugins[0]
      ? []
      : await tx.select().from(PluginTable).where(and(
          eq(PluginTable.organizationId, organizationId),
          eq(PluginTable.createdByOrgMembershipId, ownerMemberId),
          eq(PluginTable.name, LEGACY_SAVED_SCRIPTS_PLUGIN_NAME),
          eq(PluginTable.status, "active"),
          isNull(PluginTable.deletedAt),
        )).limit(1).for("update")
    const plugin = plugins[0] ?? legacyPlugins[0]
    if (requestedPluginId && !plugin) throw new Error("saved_program_plugin_not_found")
    const pluginId = plugin?.id ?? createDenTypeId("plugin")
    if (!plugin) {
      await tx.insert(PluginTable).values({
        id: pluginId,
        organizationId,
        name: DEFAULT_PROGRAMS_PLUGIN_NAME,
        description: "Private reusable Code Mode Programs.",
        status: "active",
        createdByOrgMembershipId: ownerMemberId,
      })
      await tx.insert(PluginAccessGrantTable).values({
        id: createDenTypeId("pluginAccessGrant"),
        organizationId,
        pluginId,
        orgMembershipId: ownerMemberId,
        teamId: null,
        orgWide: false,
        role: "manager",
        createdByOrgMembershipId: ownerMemberId,
      })
    } else if (!requestedPluginId && plugin.name === LEGACY_SAVED_SCRIPTS_PLUGIN_NAME) {
      await tx.update(PluginTable).set({
        name: DEFAULT_PROGRAMS_PLUGIN_NAME,
        description: "Private reusable Code Mode Programs.",
      }).where(eq(PluginTable.id, plugin.id))
    }

    const linked = await tx.select({ object: ConfigObjectTable }).from(PluginConfigObjectTable)
      .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginConfigObjectTable.configObjectId))
      .where(and(
        eq(PluginConfigObjectTable.pluginId, pluginId),
        isNull(PluginConfigObjectTable.removedAt),
        eq(ConfigObjectTable.title, input.script.name),
        eq(ConfigObjectTable.objectType, "script"),
        eq(ConfigObjectTable.status, "active"),
        isNull(ConfigObjectTable.deletedAt),
      )).limit(1).for("update")
    const configObjectId = linked[0]?.object.id ?? createDenTypeId("configObject")
    if (linked[0]) {
      // Saving the same name creates a new immutable version of the existing
      // Program. Plugin edit access can widen the audience, but it must never
      // grant authority to replace another Program manager's executable code.
      if (!input.context) throw new Error("saved_program_manager_context_required")
      await requirePluginArchResourceRole({
        context: input.context,
        resourceId: configObjectId,
        resourceKind: "config_object",
        role: "manager",
      })
    } else {
      await tx.insert(ConfigObjectTable).values({
        id: configObjectId,
        organizationId,
        objectType: "script",
        sourceMode: "cloud",
        title: input.script.name,
        description: input.script.description?.trim() || null,
        searchText: `${input.script.name} ${input.script.description ?? ""}`.trim(),
        currentFileName: `${input.script.name}.js`,
        currentFileExtension: "js",
        status: "active",
        createdByOrgMembershipId: ownerMemberId,
      })
      await tx.insert(PluginConfigObjectTable).values({
        id: createDenTypeId("pluginConfigObject"),
        organizationId,
        pluginId,
        configObjectId,
        membershipSource: "manual",
        createdByOrgMembershipId: ownerMemberId,
      })
      await tx.insert(ConfigObjectAccessGrantTable).values({
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        configObjectId,
        orgMembershipId: ownerMemberId,
        teamId: null,
        orgWide: false,
        role: "manager",
        createdByOrgMembershipId: ownerMemberId,
      })
    }
    const configObjectVersionId: DenTypeId<"configObjectVersion"> = createDenTypeId("configObjectVersion")
    await tx.insert(ConfigObjectVersionTable).values({
      id: configObjectVersionId,
      organizationId,
      configObjectId,
      normalizedPayloadJson,
      rawSourceText: input.script.code,
      schemaVersion: "codemode-script-v1",
      createdVia: "cloud",
      createdByOrgMembershipId: ownerMemberId,
      sourceRevisionRef: receipt.code_digest,
      isDeletedVersion: false,
    })
    return { pluginId, configObjectId, configObjectVersionId }
  })
}
