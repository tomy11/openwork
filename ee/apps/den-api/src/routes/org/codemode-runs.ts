import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { listCodemodeRuns } from "../../codemode-runs.js"
import { db } from "../../db.js"
import { orgMemberRoute, queryValidator } from "../../middleware/index.js"
import { denTypeIdSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { memberHasRole } from "./shared.js"

const listCodemodeRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
})

const codemodeRunSchema = z.object({
  id: denTypeIdSchema("codemodeRun"),
  source: z.string(),
  status: z.enum(["succeeded", "failed"]),
  errorKind: z.string().nullable(),
  errorMessage: z.string().nullable(),
  toolCallCount: z.number().int(),
  toolCalls: z.array(z.object({ name: z.string() })).nullable(),
  durationMs: z.number().int(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  orgMembershipId: denTypeIdSchema("member").nullable(),
})

const codemodeRunListResponseSchema = z.object({
  runs: z.array(codemodeRunSchema),
}).meta({ ref: "CodemodeRunListResponse" })

export function registerOrgCodemodeRunRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/codemode-runs",
    describeRoute({
      tags: ["Codemode Runs"],
      summary: "List Code Mode script runs",
      description: "Lists Code Mode script run receipts visible to the active organization member.",
      responses: {
        200: jsonResponse("Code Mode script runs returned successfully.", codemodeRunListResponseSchema),
        400: jsonResponse("The Code Mode script run list query was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list Code Mode script runs.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(listCodemodeRunsQuerySchema),
    async (c) => {
      const context = c.get("organizationContext")
      const member = context.currentMember
      const isAdmin = member.isOwner || memberHasRole(member.role, "admin")
      const rows = await listCodemodeRuns(db, {
        organizationId: context.organization.id,
        ...(isAdmin ? {} : { orgMembershipId: member.id }),
        limit: c.req.valid("query").limit,
      })

      return c.json({
        runs: rows.map((row) => ({
          id: row.id,
          source: row.source,
          status: row.status,
          errorKind: row.error_kind,
          errorMessage: row.error_message,
          toolCallCount: row.tool_call_count,
          toolCalls: row.tool_calls,
          durationMs: row.duration_ms,
          startedAt: row.started_at.toISOString(),
          finishedAt: row.finished_at.toISOString(),
          createdAt: row.created_at.toISOString(),
          orgMembershipId: row.org_membership_id,
        })),
      })
    },
  )
}
