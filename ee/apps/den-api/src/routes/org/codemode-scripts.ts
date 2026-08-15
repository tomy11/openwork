import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  savedScriptArtifactSnapshotSchema,
  savedScriptCapabilitySchema,
  savedScriptDetailSchema,
  savedScriptTestResultSchema,
  savedScriptVersionSchema,
  generatedArtifactViewSchema,
} from "@openwork/types/dynamic-artifacts"
import {
  createCodemodeScriptVersion,
  deleteCodemodeScriptSnapshotContent,
  getCodemodeScriptDetail,
  getCodemodeScriptSnapshot,
  listCodemodeScriptSnapshots,
  listCodemodeScriptVersions,
  saveCodemodeScript,
  testCodemodeScriptDraft,
} from "../../codemode-scripts.js"
import { orgMemberRoute, jsonValidator, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { listTeamsForMember } from "../../orgs.js"
import { env } from "../../env.js"
import { getCatalog } from "../../mcp/index.js"
import { buildCapabilityToolTree, createCapabilityRegistryContext } from "../../mcp/capability-registry.js"
import {
  executeMarketplaceCapability,
  listAccessibleSavedCodemodeScripts,
} from "../../mcp/marketplace-capabilities.js"
import { DEN_MCP_REQUESTED_SCOPES } from "../../mcp/scopes.js"
import { codemodeScriptsEnabled } from "../../capability-sources/codemode-rollout.js"
import { PluginArchAuthorizationError } from "./plugin-system/access.js"
import type { OrgRouteVariables } from "./shared.js"
import { codemodeCodeDigest } from "../../codemode-runs.js"
import { getProgramDetail } from "../../program-library.js"
import {
  activateArtifactViewRevision,
  listArtifactViewsForScript,
  retireArtifactView,
} from "../../artifact-views.js"
import {
  clearProgramAgentSelection,
  getProgramAgentSelection,
  selectProgramForAgent,
} from "../../program-agent-selection.js"

const capabilitySchema = z.object({ capabilityName: z.string(), scriptPath: z.string() })
const scriptSchema = z.object({
  pluginId: z.string(),
  configObjectId: z.string(),
  configObjectVersionId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  inputSchema: z.unknown().nullable(),
  outputSchema: z.unknown().nullable(),
  requiredCapabilities: z.array(capabilitySchema),
})
const listSchema = z.object({ items: z.array(scriptSchema) })
const saveSchema = z.object({
  pluginId: z.string().trim().min(1).max(160).optional().describe("Existing OpenWork Connect Plugin that will contain and share this Program. Omit to use the member's private My Programs Plugin."),
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(4_000).optional(),
  code: z.string().min(1).max(200_000),
  currentInput: z.unknown().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional().describe("Optional JSON Schema for the value returned by this Program."),
})
const savedSchema = z.object({ pluginId: z.string(), configObjectId: z.string(), configObjectVersionId: z.string() })
const runParamsSchema = z.object({ configObjectId: z.string().min(1).max(160) })
const runSchema = z.object({
  pluginId: z.string().min(1).max(160),
  configObjectVersionId: z.string().min(1).max(160),
  input: z.unknown().optional(),
})
const runResultSchema = z.object({
  status: z.literal("succeeded"),
  value: z.unknown(),
  markdown: z.string(),
  receiptId: z.string().nullable(),
  resultDigest: z.string(),
  inputSchemaDigest: z.string().nullable(),
  outputSchemaDigest: z.string().nullable(),
  rendererVersion: z.literal("codemode-markdown-v1"),
})
const detailParamsSchema = z.object({
  configObjectId: z.string().min(1).max(160),
  receiptId: z.string().min(1).max(160).optional(),
})
const detailQuerySchema = z.object({
  maxAgeMs: z.coerce.number().int().min(60_000).max(30 * 24 * 60 * 60_000).optional(),
})
const snapshotsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() })
const draftSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(4_000).optional(),
  code: z.string().min(1).max(200_000),
  exampleInput: z.unknown().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional().describe("Optional JSON Schema for the value returned by this Program."),
  requiredCapabilities: z.array(savedScriptCapabilitySchema).max(100),
})
const testSchema = draftSchema.extend({ configObjectId: z.string().min(1).max(160) })
const versionSchema = draftSchema.extend({
  receiptId: z.string().min(1).max(160).describe("Copy receiptId from the immediately preceding successful draft test. Submit the exact same name, description, code, exampleInput, inputSchema, outputSchema, and requiredCapabilities used by that test."),
})
const versionsResponseSchema = z.object({ items: z.array(savedScriptVersionSchema) })
const snapshotsResponseSchema = z.object({ items: z.array(savedScriptArtifactSnapshotSchema) })
const programDetailSchema = z.object({
  program: z.object({
    type: z.literal("program"), id: z.string(), plugin: z.object({ id: z.string(), name: z.string() }).nullable(), name: z.string(), description: z.string().nullable(),
    role: z.enum(["viewer", "editor", "manager"]), edges: z.array(z.unknown()),
    state: z.enum(["ready", "needs_signin", "needs_admin_setup"]),
    resultState: z.enum(["never_run", "fresh", "stale", "needs_attention"]),
    latestSuccessfulAt: z.string().datetime().nullable(),
    viewState: z.enum(["default", "custom_active", "build_failed", "retired"]),
    activeViewTitle: z.string().nullable(), automationCount: z.number().int().nonnegative(),
    source: z.object({ kind: z.enum(["created", "installed_template"]), templateName: z.string().optional(), templateVersion: z.string().optional() }),
  }),
  script: savedScriptDetailSchema,
  views: z.array(generatedArtifactViewSchema),
})
const artifactViewsResponseSchema = z.object({ items: z.array(generatedArtifactViewSchema) })
const programSelectionSchema = z.object({
  organizationId: z.string(), orgMembershipId: z.string(), programId: z.string(), selectedAt: z.string().datetime(),
})
const programSelectionResponseSchema = z.object({ selection: programSelectionSchema.nullable() })
const programSelectionWriteSchema = z.object({ programId: z.string().trim().min(1).max(160) })
const artifactViewParamsSchema = z.object({
  artifactViewId: z.string().trim().min(1).max(160),
  revisionId: z.string().trim().min(1).max(160).optional(),
})

function routeFailure(error: unknown) {
  if (error instanceof PluginArchAuthorizationError) {
    return { status: error.status, body: { error: error.error, message: error.message } } as const
  }
  const message = error instanceof Error ? error.message : "Saved Script request failed."
  if (message.includes("not_found")) return { status: 404, body: { error: "saved_script_not_found", message } } as const
  if (message === "saved_script_matching_test_receipt_required") {
    return {
      status: 400,
      body: {
        error: message,
        message: "Test the draft first, then immediately create the version using that successful test's receiptId and the exact unchanged name, description, code, exampleInput, inputSchema, outputSchema, and requiredCapabilities. Do not reuse an older receipt or alter any draft field between the two calls.",
      },
    } as const
  }
  if (message === "saved_script_recent_receipt_required") {
    return {
      status: 400,
      body: {
        error: message,
        message: "Run the exact Script code successfully with execute_capability_script, then retry saving the Script without changing the code. The successful run must be less than 15 minutes old.",
      },
    } as const
  }
  return { status: 400, body: { error: "saved_script_rejected", message } } as const
}

export const saveProgramOperationId = "saveProgram"

export function registerOrgCodemodeScriptRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  const contextFor = async (c: {
    get(name: "organizationContext"): OrgRouteVariables["organizationContext"]
    get(name: "session"): OrgRouteVariables["session"]
    env: unknown
  }) => {
    const context = c.get("organizationContext")
    if (!context) throw new Error("organization_context_required")
    const teams = await listTeamsForMember({ organizationId: context.organization.id, memberId: context.currentMember.id })
    const member = { orgMembershipId: context.currentMember.id, teamIds: teams.map((team) => team.id) }
    const catalog = await getCatalog(app as unknown as Hono, c.env)
    const principal = {
      userId: context.currentMember.userId,
      organizationId: context.organization.id,
      scopes: new Set(DEN_MCP_REQUESTED_SCOPES),
      payload: {},
    }
    const codemodeEnabled = codemodeScriptsEnabled(context.organization.metadata)
    const capabilityContext = createCapabilityRegistryContext({
      app: app as unknown as Hono,
      env: c.env,
      catalog,
      principal,
      organizationId: context.organization.id,
      member,
      redirectUriBase: env.apiPublicUrl ?? "http://127.0.0.1",
      codemodeEnabled,
      generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
      organizationMetadata: context.organization.metadata,
      mcpConnectionsGatingEnabled: env.mcpConnectionsGatingEnabled,
    })
    const buildTools = () => buildCapabilityToolTree(capabilityContext)
    const actorContext = { organizationContext: context, memberTeams: teams, session: c.get("session") }
    return { context, member, actorContext, buildTools, codemodeEnabled }
  }

  app.get(
    "/v1/codemode-scripts",
    describeRoute({
      tags: ["Codemode Runs"], summary: "List accessible saved Code Mode scripts",
      responses: { 200: jsonResponse("Saved scripts returned.", listSchema), 401: jsonResponse("Sign-in required.", unauthorizedSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      const { context, member, codemodeEnabled } = await contextFor(c)
      if (!codemodeEnabled) return c.json({ items: [] })
      return c.json({ items: await listAccessibleSavedCodemodeScripts({ organizationId: context.organization.id, member }) })
    },
  )

  app.post(
    "/v1/codemode-scripts",
    describeRoute({
      operationId: saveProgramOperationId,
      tags: ["Codemode Runs"], summary: "Save a successful Code Mode run as a Program inside an OpenWork Connect Plugin",
      responses: {
        201: jsonResponse("Program saved.", savedSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        403: jsonResponse("The caller cannot add Programs to this Plugin.", forbiddenSchema),
        404: jsonResponse("Plugin not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), jsonValidator(saveSchema),
    async (c) => {
      try {
        const { context, actorContext, buildTools, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        const saved = await saveCodemodeScript({
          organizationId: context.organization.id,
          ownerMemberId: context.currentMember.id,
          script: c.req.valid("json"),
          buildTools,
          context: actorContext,
        })
        return c.json(saved, 201)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/codemode-scripts/:configObjectId",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Inspect a saved Script and its artifact lifecycle",
      responses: {
        200: jsonResponse("Saved Script returned.", savedScriptDetailSchema),
        404: jsonResponse("Saved Script not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), queryValidator(detailQuerySchema),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Script id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) return c.json({ error: "saved_script_not_found" }, 404)
        return c.json(await getCodemodeScriptDetail({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          maxAgeMs: c.req.valid("query").maxAgeMs,
        }))
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/programs/:configObjectId",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Inspect a Program",
      responses: { 200: jsonResponse("Program returned.", programDetailSchema), 404: jsonResponse("Program not found.", notFoundSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Program id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) return c.json({ error: "program_not_found" }, 404)
        const detail = await getProgramDetail({ context: actorContext, configObjectId: params.data.configObjectId })
        return c.json(env.generatedArtifactViewsEnabled
          ? detail
          : {
              ...detail,
              program: { ...detail.program, viewState: "default" as const, activeViewTitle: null },
              views: [],
            })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/programs/:configObjectId/views",
    describeRoute({
      tags: ["Codemode Runs"], summary: "List generated Artifact views for a Program",
      responses: { 200: jsonResponse("Artifact views returned.", artifactViewsResponseSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Program id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled || !env.generatedArtifactViewsEnabled) return c.json({ items: [] })
        return c.json({ items: await listArtifactViewsForScript({ context: actorContext, configObjectId: params.data.configObjectId }) })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/artifact-views/:artifactViewId/revisions/:revisionId/activate",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Activate or roll back an immutable Artifact view revision",
      responses: { 200: jsonResponse("Artifact view activated.", generatedArtifactViewSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      if (!env.generatedArtifactViewsEnabled) return c.json({ error: "artifact_view_not_found" }, 404)
      const params = artifactViewParamsSchema.safeParse(c.req.param())
      if (!params.success || !params.data.revisionId) return c.json({ error: "invalid_request", message: "Invalid view revision." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        return c.json(await activateArtifactViewRevision({ context: actorContext, artifactViewId: params.data.artifactViewId, revisionId: params.data.revisionId }))
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/artifact-views/:artifactViewId/retire",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Retire a generated Artifact view",
      responses: { 200: jsonResponse("Artifact view retired.", generatedArtifactViewSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      if (!env.generatedArtifactViewsEnabled) return c.json({ error: "artifact_view_not_found" }, 404)
      const params = artifactViewParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid view." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        return c.json(await retireArtifactView({ context: actorContext, artifactViewId: params.data.artifactViewId }))
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/me/program-selection",
    describeRoute({ tags: ["Codemode Runs"], summary: "Get my selected Program", responses: { 200: jsonResponse("Program selection returned.", programSelectionResponseSchema) } }),
    orgMemberRoute(),
    async (c) => {
      const { actorContext, codemodeEnabled } = await contextFor(c)
      return c.json({ selection: codemodeEnabled ? await getProgramAgentSelection(actorContext) : null })
    },
  )

  app.put(
    "/v1/me/program-selection",
    describeRoute({ tags: ["Codemode Runs"], summary: "Select a Program for MCP", responses: { 200: jsonResponse("Program selected.", programSelectionResponseSchema) } }),
    orgMemberRoute(), jsonValidator(programSelectionWriteSchema),
    async (c) => {
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        return c.json({ selection: await selectProgramForAgent({ context: actorContext, programId: c.req.valid("json").programId }) })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.delete(
    "/v1/me/program-selection",
    describeRoute({ tags: ["Codemode Runs"], summary: "Clear my selected Program", responses: { 200: jsonResponse("Program selection cleared.", programSelectionResponseSchema) } }),
    orgMemberRoute(),
    async (c) => {
      const { actorContext } = await contextFor(c)
      await clearProgramAgentSelection(actorContext)
      return c.json({ selection: null })
    },
  )

  app.get(
    "/v1/codemode-scripts/:configObjectId/versions",
    describeRoute({
      tags: ["Codemode Runs"], summary: "List immutable saved Script versions",
      responses: { 200: jsonResponse("Script versions returned.", versionsResponseSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Script id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) return c.json({ items: [] })
        return c.json({ items: await listCodemodeScriptVersions({ context: actorContext, configObjectId: params.data.configObjectId }) })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/codemode-scripts/:configObjectId/snapshots",
    describeRoute({
      tags: ["Codemode Runs"], summary: "List saved Script artifact snapshots",
      responses: { 200: jsonResponse("Artifact snapshots returned.", snapshotsResponseSchema) },
    }),
    orgMemberRoute(), queryValidator(snapshotsQuerySchema),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Script id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) return c.json({ items: [] })
        return c.json({ items: await listCodemodeScriptSnapshots({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          limit: c.req.valid("query").limit,
        }) })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/codemode-scripts/:configObjectId/snapshots/:receiptId",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Inspect one saved Script artifact snapshot",
      responses: {
        200: jsonResponse("Artifact snapshot returned.", savedScriptArtifactSnapshotSchema),
        404: jsonResponse("Artifact snapshot not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success || !params.data.receiptId) return c.json({ error: "invalid_request", message: "Invalid snapshot id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) return c.json({ error: "saved_script_snapshot_not_found" }, 404)
        const snapshot = await getCodemodeScriptSnapshot({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          receiptId: params.data.receiptId,
        })
        return snapshot ? c.json(snapshot) : c.json({ error: "saved_script_snapshot_not_found" }, 404)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/codemode-scripts/test",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Test the exact saved Script draft and return the receiptId required to create that unchanged version",
      responses: { 200: jsonResponse("Script draft tested.", savedScriptTestResultSchema), 400: jsonResponse("Test rejected.", invalidRequestSchema) },
    }),
    orgMemberRoute(), jsonValidator(testSchema),
    async (c) => {
      try {
        const { actorContext, buildTools, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        const body = c.req.valid("json")
        const { configObjectId, ...draft } = body
        const result = await testCodemodeScriptDraft({ context: actorContext, configObjectId, draft, buildTools })
        if (!result.ok) return c.json({ error: result.error, message: result.message }, 400)
        return c.json({
          receiptId: result.receiptId,
          value: result.value,
          markdown: result.markdown,
          codeDigest: codemodeCodeDigest(draft.code),
          resultDigest: result.resultDigest,
          inputSchemaDigest: result.inputSchemaDigest,
          outputSchemaDigest: result.outputSchemaDigest,
          rendererVersion: result.rendererVersion,
          requiredCapabilities: result.requiredCapabilities,
          finishedAt: result.finishedAt,
        })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/codemode-scripts/:configObjectId/versions",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Create an immutable saved Script version using the immediately preceding matching test receipt and unchanged draft",
      responses: { 201: jsonResponse("Script version created.", savedScriptDetailSchema), 400: jsonResponse("Version rejected.", invalidRequestSchema) },
    }),
    orgMemberRoute(), jsonValidator(versionSchema),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Script id." }, 400)
      try {
        const { actorContext, buildTools, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        const body = c.req.valid("json")
        const { receiptId, ...draft } = body
        return c.json(await createCodemodeScriptVersion({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          receiptId,
          draft,
          buildTools,
        }), 201)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/codemode-scripts/:configObjectId/run",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Run an exact saved Code Mode script version",
      responses: {
        200: jsonResponse("Script executed.", runResultSchema),
        400: jsonResponse("Execution rejected.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), jsonValidator(runSchema),
    async (c) => {
      const params = runParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid script id." }, 400)
      const { context, member, buildTools, codemodeEnabled } = await contextFor(c)
      const body = c.req.valid("json")
      const result = await executeMarketplaceCapability({
        organizationId: context.organization.id,
        member,
        pluginId: body.pluginId,
        configObjectId: params.data.configObjectId,
        configObjectVersionId: body.configObjectVersionId,
        body: body.input,
        codemodeEnabled,
        validateScriptOutput: true,
        buildTools,
      })
      if (!result.ok) return c.json({ error: result.error, message: result.message }, 400)
      if (result.result.status !== "executed") {
        return c.json({ error: "script_not_executable", message: result.result.hint ?? "Script could not execute." }, 400)
      }
      const canonical = result.result.canonicalResult ?? JSON.stringify(result.result.value)
      return c.json({
        status: "succeeded" as const,
        value: result.result.value,
        markdown: result.result.markdown ?? `\`\`\`json\n${canonical}\n\`\`\``,
        receiptId: result.result.receiptId,
        resultDigest: result.result.resultDigest ?? "",
        inputSchemaDigest: result.result.inputSchemaDigest ?? null,
        outputSchemaDigest: result.result.outputSchemaDigest ?? null,
        rendererVersion: result.result.rendererVersion ?? "codemode-markdown-v1",
      })
    },
  )

  app.delete(
    "/v1/codemode-scripts/:configObjectId/snapshots/:receiptId/content",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Delete artifact content while retaining its audit receipt",
      responses: { 200: jsonResponse("Artifact content deleted.", savedScriptArtifactSnapshotSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success || !params.data.receiptId) return c.json({ error: "invalid_request", message: "Invalid snapshot id." }, 400)
      try {
        const { actorContext, codemodeEnabled } = await contextFor(c)
        if (!codemodeEnabled) throw new Error("codemode_scripts_disabled")
        const snapshot = await deleteCodemodeScriptSnapshotContent({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          receiptId: params.data.receiptId,
        })
        return snapshot ? c.json(snapshot) : c.json({ error: "saved_script_snapshot_not_found" }, 404)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )
}
