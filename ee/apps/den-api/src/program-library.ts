import { and, asc, desc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import type { GeneratedArtifactView } from "@openwork/types/dynamic-artifacts"
import { db } from "./db.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { getCodemodeScriptDetail } from "./codemode-scripts.js"
import { listArtifactViewsForScript } from "./artifact-views.js"
import {
  resolvePluginArchResourceRole,
  type PluginArchActorContext,
  type PluginArchRole,
} from "./routes/org/plugin-system/access.js"
import {
  listMeEffectivePluginAccess,
  type MePluginAccessEdge,
} from "./routes/org/plugin-system/store.js"
import {
  listMemberUsableConnectionFacts,
  type MemberUsableConnectionFacts,
} from "./routes/org/mcp-connections.js"

export type ProgramLibraryItem = {
  type: "program"
  id: string
  plugin: { id: string; name: string } | null
  name: string
  description: string | null
  role: PluginArchRole
  edges: MePluginAccessEdge[]
  state: "ready" | "needs_signin" | "needs_admin_setup"
  resultState: "never_run" | "fresh" | "stale" | "needs_attention"
  latestSuccessfulAt: string | null
  viewState: "default" | "custom_active" | "build_failed" | "retired"
  activeViewTitle: string | null
  automationCount: number
  source: { kind: "created" | "installed_template"; templateName?: string; templateVersion?: string }
}

export type ProgramDetail = {
  program: ProgramLibraryItem
  script: Awaited<ReturnType<typeof getCodemodeScriptDetail>>
  views: GeneratedArtifactView[]
}

function accessEdges(input: {
  context: PluginArchActorContext
  createdByOrgMembershipId: string
  grants: Array<typeof ConfigObjectAccessGrantTable.$inferSelect>
  inheritedEdges: MePluginAccessEdge[]
}): MePluginAccessEdge[] {
  const memberId = input.context.organizationContext.currentMember.id
  const teamsById = new Map(input.context.memberTeams.map((team) => [team.id, team]))
  const edges = new Map<string, MePluginAccessEdge>()
  for (const edge of input.inheritedEdges) {
    const key = edge.kind === "team"
      ? `team:${edge.team.id}`
      : edge.kind === "catalog"
        ? `catalog:${edge.marketplace.id}`
        : edge.kind
    edges.set(key, edge)
  }
  if (input.createdByOrgMembershipId === memberId) edges.set("mine", { kind: "mine" })
  for (const grant of input.grants) {
    if (grant.removedAt) continue
    if (grant.orgMembershipId === memberId) {
      edges.set("person", {
        kind: "person",
        sharedBy: null,
        grantedAt: grant.createdAt.toISOString(),
      })
    }
    if (grant.orgWide) edges.set("org_wide", { kind: "org_wide" })
    if (grant.teamId) {
      const team = teamsById.get(grant.teamId)
      if (team) edges.set(`team:${team.id}`, { kind: "team", team: { id: team.id, name: team.name } })
    }
  }
  return [...edges.values()]
}

function viewLifecycle(views: GeneratedArtifactView[]) {
  const active = views.find((view) => view.status === "active" && view.activeRevisionId !== null)
  if (active) return { viewState: "custom_active" as const, activeViewTitle: active.title }
  if (views.some((view) => view.status === "active" && view.revisions.some((revision) => revision.buildStatus === "failed"))) {
    return { viewState: "build_failed" as const, activeViewTitle: null }
  }
  if (views.length > 0 && views.every((view) => view.status === "retired")) {
    return { viewState: "retired" as const, activeViewTitle: null }
  }
  return { viewState: "default" as const, activeViewTitle: null }
}

function connectionReadiness(connection: MemberUsableConnectionFacts) {
  if (
    connection.setupRequired
    || connection.issuerReviewRequired
    || connection.reconnectActionOwner === "organization_admin"
    || connection.authPolicyConfirmed === false
    || connection.authTypeMismatch
    || (connection.oauthClientRequired && !connection.oauthClientConfigured)
    || (connection.credentialMode === "shared" && !connection.connectedForMe)
  ) return "needs_admin_setup" as const
  if (connection.credentialMode === "per_member" && (!connection.connectedForMe || connection.needsReconnect)) {
    return "needs_signin" as const
  }
  return "ready" as const
}

function programReadiness(input: {
  connections: MemberUsableConnectionFacts[]
  requiredCapabilities: Array<{ capabilityName: string }>
}) {
  const connections = new Map(input.connections.map((connection) => [connection.id, connection]))
  let state: ProgramLibraryItem["state"] = "ready"
  for (const capability of input.requiredCapabilities) {
    const match = /^mcp:([^:]+):/.exec(capability.capabilityName)
    if (!match) continue
    const connection = connections.get(match[1] ?? "")
    const requirementState = connection ? connectionReadiness(connection) : "needs_admin_setup"
    if (requirementState === "needs_admin_setup") return requirementState
    if (requirementState === "needs_signin") state = requirementState
  }
  return state
}

async function programItem(input: {
  context: PluginArchActorContext
  row: typeof ConfigObjectTable.$inferSelect
  plugin: { id: string; name: string } | null
  inheritedEdges: MePluginAccessEdge[]
  connections: MemberUsableConnectionFacts[]
}): Promise<ProgramLibraryItem | null> {
  const role = await resolvePluginArchResourceRole({
    context: input.context,
    resourceId: input.row.id,
    resourceKind: "config_object",
  })
  if (!role) return null
  try {
    const [script, views, grants] = await Promise.all([
      getCodemodeScriptDetail({ context: input.context, configObjectId: input.row.id }),
      listArtifactViewsForScript({ context: input.context, configObjectId: input.row.id }),
      db.select().from(ConfigObjectAccessGrantTable).where(and(
        eq(ConfigObjectAccessGrantTable.organizationId, input.context.organizationContext.organization.id),
        eq(ConfigObjectAccessGrantTable.configObjectId, input.row.id),
      )),
    ])
    const automationIds = new Set(script.versions.flatMap((version) => version.automationReferences.map((reference) => reference.id)))
    const latestSuccessfulAt = script.latestSuccessfulSnapshot?.finishedAt ?? null
    return {
      type: "program",
      id: script.configObjectId,
      plugin: input.plugin,
      name: script.title,
      description: script.description,
      role,
      edges: accessEdges({
        context: input.context,
        createdByOrgMembershipId: input.row.createdByOrgMembershipId,
        grants,
        inheritedEdges: input.inheritedEdges,
      }),
      state: programReadiness({
        connections: input.connections,
        requiredCapabilities: script.currentVersion.requiredCapabilities,
      }),
      resultState: script.freshness.state,
      latestSuccessfulAt,
      ...viewLifecycle(views),
      automationCount: automationIds.size,
      source: { kind: "created" },
    }
  } catch {
    return null
  }
}

export async function listProgramLibraryItems(input: { context: PluginArchActorContext }) {
  const [rows, effectiveAccess, connections] = await Promise.all([
    db.select({
      configObject: ConfigObjectTable,
      pluginId: PluginConfigObjectTable.pluginId,
      pluginName: PluginTable.name,
    })
      .from(ConfigObjectTable)
      .innerJoin(PluginConfigObjectTable, and(
        eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
        isNull(PluginConfigObjectTable.removedAt),
      ))
      .innerJoin(PluginTable, and(
        eq(PluginTable.id, PluginConfigObjectTable.pluginId),
        eq(PluginTable.organizationId, ConfigObjectTable.organizationId),
        eq(PluginTable.status, "active"),
        isNull(PluginTable.deletedAt),
      ))
      .where(and(
        eq(ConfigObjectTable.organizationId, input.context.organizationContext.organization.id),
        eq(ConfigObjectTable.objectType, "script"),
        eq(ConfigObjectTable.status, "active"),
        isNull(ConfigObjectTable.deletedAt),
      ))
      .orderBy(
        desc(ConfigObjectTable.updatedAt),
        desc(ConfigObjectTable.id),
        asc(PluginConfigObjectTable.createdAt),
        asc(PluginConfigObjectTable.id),
      ),
    listMeEffectivePluginAccess({ context: input.context }),
    listMemberUsableConnectionFacts({ context: input.context }),
  ])
  const pluginEdges = new Map(effectiveAccess.items.map((item) => [item.plugin.id, item.edges]))
  const programs = new Map<string, {
    row: typeof ConfigObjectTable.$inferSelect
    plugin: { id: string; name: string } | null
    inheritedEdges: MePluginAccessEdge[]
  }>()
  for (const { configObject, pluginId, pluginName } of rows) {
    const pluginIsVisible = pluginEdges.has(pluginId)
    const program = programs.get(configObject.id) ?? {
      row: configObject,
      plugin: null,
      inheritedEdges: [],
    }
    if (!program.plugin && pluginIsVisible) {
      program.plugin = { id: pluginId, name: pluginName }
    }
    program.inheritedEdges.push(...(pluginEdges.get(pluginId) ?? []))
    programs.set(configObject.id, program)
  }
  const items = await Promise.all([...programs.values()].map(({ row, plugin, inheritedEdges }) =>
    programItem({ context: input.context, row, plugin, inheritedEdges, connections })))
  return items.filter((item): item is ProgramLibraryItem => item !== null)
}

export async function getProgramDetail(input: {
  context: PluginArchActorContext
  configObjectId: string
}): Promise<ProgramDetail> {
  const [script, views, effectiveAccess, connections] = await Promise.all([
    getCodemodeScriptDetail({ context: input.context, configObjectId: input.configObjectId }),
    listArtifactViewsForScript({ context: input.context, configObjectId: input.configObjectId }),
    listMeEffectivePluginAccess({ context: input.context }),
    listMemberUsableConnectionFacts({ context: input.context }),
  ])
  const rows = await db.select().from(ConfigObjectTable).where(eq(
    ConfigObjectTable.id,
    normalizeDenTypeId("configObject", script.configObjectId),
  )).limit(1)
  const row = rows[0]
  if (!row) throw new Error("dynamic_program_not_found")
  const memberships = await db.select({ pluginId: PluginConfigObjectTable.pluginId, pluginName: PluginTable.name })
    .from(PluginConfigObjectTable)
    .innerJoin(PluginTable, eq(PluginTable.id, PluginConfigObjectTable.pluginId))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.context.organizationContext.organization.id),
      eq(PluginConfigObjectTable.configObjectId, row.id),
      isNull(PluginConfigObjectTable.removedAt),
    ))
    .orderBy(asc(PluginConfigObjectTable.createdAt), asc(PluginConfigObjectTable.id))
  const pluginEdges = new Map(effectiveAccess.items.map((item) => [item.plugin.id, item.edges]))
  const inheritedEdges = memberships.flatMap(({ pluginId }) => pluginEdges.get(pluginId) ?? [])
  if (!memberships[0]) throw new Error("dynamic_program_not_found")
  const visibleParent = memberships.find(({ pluginId }) => pluginEdges.has(pluginId))
  const program = await programItem({
    context: input.context,
    row,
    plugin: visibleParent ? { id: visibleParent.pluginId, name: visibleParent.pluginName } : null,
    inheritedEdges,
    connections,
  })
  if (!program) throw new Error("dynamic_program_not_found")
  return { program, script, views }
}
