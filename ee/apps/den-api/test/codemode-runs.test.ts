import { createDenDb } from "@openwork-ee/den-db"
import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { CodemodeRunTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { codemodeCodeDigest, listCodemodeRuns, recordCodemodeRun, type RecordCodemodeRunInput } from "../src/codemode-runs.js"

const databaseUrl = "mysql://root:password@127.0.0.1:3306/openwork_test_codemode_runs"
const database = createDenDb({ databaseUrl, mode: "mysql" }).db
const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const firstMemberId = createDenTypeId("member")
const secondMemberId = createDenTypeId("member")
let databaseAvailable = true

beforeAll(async () => {
  try {
    await database.execute(sql`select 1`)
  } catch (error) {
    databaseAvailable = false
    console.warn("Skipping codemode run DB assertions because local MySQL is unavailable.", error)
  }
}, 20_000)

afterAll(async () => {
  if (databaseAvailable) {
    await database.delete(CodemodeRunTable).where(eq(CodemodeRunTable.organization_id, organizationId))
    await database.delete(CodemodeRunTable).where(eq(CodemodeRunTable.organization_id, otherOrganizationId))
  }
})

test("code digest is stable and sha256-prefixed", () => {
  const digest = codemodeCodeDigest("return await tools.den.getV1Org({})")
  expect(digest).toBe(codemodeCodeDigest("return await tools.den.getV1Org({})"))
  expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/)
})

test("records and lists organization and member-scoped runs", async () => {
  if (!databaseAvailable) return

  const now = new Date()
  const common: Omit<RecordCodemodeRunInput, "organizationId" | "orgMembershipId"> = {
    code: "return true",
    source: "adhoc",
    status: "succeeded",
    toolCalls: [{ name: "den.getV1Org" }],
    durationMs: 12,
    startedAt: now,
    finishedAt: now,
  }
  await recordCodemodeRun(database, { ...common, organizationId, orgMembershipId: firstMemberId })
  await recordCodemodeRun(database, { ...common, organizationId, orgMembershipId: secondMemberId })
  await recordCodemodeRun(database, { ...common, organizationId: otherOrganizationId, orgMembershipId: firstMemberId })

  const adminRuns = await listCodemodeRuns(database, { organizationId })
  const memberRuns = await listCodemodeRuns(database, { organizationId, orgMembershipId: firstMemberId })

  expect(adminRuns).toHaveLength(2)
  expect(memberRuns).toHaveLength(1)
  expect(memberRuns[0]?.org_membership_id).toBe(firstMemberId)
  expect(memberRuns[0]?.tool_call_count).toBe(1)
})
