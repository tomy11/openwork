import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ProgramAgentSelectionTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { getCodemodeScriptDetail } from "./codemode-scripts.js"
import type { PluginArchActorContext } from "./routes/org/plugin-system/access.js"

export type ProgramAgentSelection = {
  organizationId: string
  orgMembershipId: string
  programId: string
  selectedAt: string
}

function selectionWhere(context: PluginArchActorContext) {
  return and(
    eq(ProgramAgentSelectionTable.organization_id, context.organizationContext.organization.id),
    eq(ProgramAgentSelectionTable.org_membership_id, context.organizationContext.currentMember.id),
  )
}

function serialize(row: typeof ProgramAgentSelectionTable.$inferSelect): ProgramAgentSelection {
  return {
    organizationId: row.organization_id,
    orgMembershipId: row.org_membership_id,
    programId: row.program_id,
    selectedAt: row.selected_at.toISOString(),
  }
}

export async function getProgramAgentSelection(context: PluginArchActorContext) {
  const rows = await db.select().from(ProgramAgentSelectionTable).where(selectionWhere(context)).limit(1)
  const row = rows[0]
  if (!row) return null
  try {
    await getCodemodeScriptDetail({ context, configObjectId: row.program_id })
    return serialize(row)
  } catch {
    await db.delete(ProgramAgentSelectionTable).where(selectionWhere(context))
    return null
  }
}

export async function selectProgramForAgent(input: {
  context: PluginArchActorContext
  programId: string
}) {
  const programId = normalizeDenTypeId("configObject", input.programId)
  await getCodemodeScriptDetail({ context: input.context, configObjectId: programId })
  const selectedAt = new Date()
  await db.insert(ProgramAgentSelectionTable).values({
    organization_id: input.context.organizationContext.organization.id,
    org_membership_id: input.context.organizationContext.currentMember.id,
    program_id: programId,
    selected_at: selectedAt,
  }).onDuplicateKeyUpdate({ set: { program_id: programId, selected_at: selectedAt } })
  return {
    organizationId: input.context.organizationContext.organization.id,
    orgMembershipId: input.context.organizationContext.currentMember.id,
    programId,
    selectedAt: selectedAt.toISOString(),
  } satisfies ProgramAgentSelection
}

export async function clearProgramAgentSelection(context: PluginArchActorContext) {
  await db.delete(ProgramAgentSelectionTable).where(selectionWhere(context))
}
