import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { StreamableHTTPTransport } from "@hono/mcp"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Context, Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import {
  getExternalMcpConnection,
  memberCanUseExternalMcpConnection,
  type ExternalMcpConnectionRow,
} from "../capability-sources/external-mcp-connections.js"
import {
  callExternalMcpToolRaw,
  describeExternalMcpServer,
  listExternalMcpResources,
  listExternalMcpResourceTemplates,
  listExternalMcpTools,
  readExternalMcpResource,
} from "../capability-sources/external-mcp-client-runtime.js"
import { externalMcpDiagnosticForResponse } from "../capability-sources/external-mcp-diagnostics.js"
import { evaluateToolPolicy } from "../capability-sources/external-mcp-tool-policy.js"
import { env } from "../env.js"
import { tokenRoute } from "../middleware/index.js"
import { resolvePublicOrigin } from "../capability-sources/generic-oauth.js"
import { getMcpResourceContext, verifyMcpRequest } from "./auth.js"
import { resolveMcpMemberIdentity } from "./external-capabilities.js"
import { preflightMcpJsonRpcRequest } from "./json-rpc-preflight.js"

function toolArguments(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

type ExternalMcpResourceOperation = Parameters<typeof describeExternalMcpServer>[0]
type ExternalMcpProxyOperation = ExternalMcpResourceOperation & {
  connection: ExternalMcpConnectionRow
  member: NonNullable<ExternalMcpResourceOperation["member"]>
  diagnosticReferenceId: string
}

type ExternalMcpProxyDescriptor = Awaited<ReturnType<typeof describeExternalMcpServer>>

type ExternalMcpProxyRuntime = {
  callTool: typeof callExternalMcpToolRaw
  listResources: typeof listExternalMcpResources
  listResourceTemplates: typeof listExternalMcpResourceTemplates
  listTools: typeof listExternalMcpTools
  readResource: typeof readExternalMcpResource
}

const externalMcpProxyRuntime: ExternalMcpProxyRuntime = {
  callTool: callExternalMcpToolRaw,
  listResources: listExternalMcpResources,
  listResourceTemplates: listExternalMcpResourceTemplates,
  listTools: listExternalMcpTools,
  readResource: readExternalMcpResource,
}

export function createExternalConnectionProxyServer(input: {
  descriptor: ExternalMcpProxyDescriptor
  operation: ExternalMcpProxyOperation
  runtime?: ExternalMcpProxyRuntime
}) {
  const { connection } = input.operation
  const runtime = input.runtime ?? externalMcpProxyRuntime
  const downstreamUi = input.descriptor.capabilities.extensions?.[EXTENSION_ID]
  const server = new McpServer(input.descriptor.serverInfo ?? {
    name: connection.name,
    version: "1.0.0",
  }, {
    capabilities: {
      ...(input.descriptor.capabilities.tools ? { tools: { listChanged: false } } : {}),
      ...(input.descriptor.capabilities.resources ? { resources: { listChanged: false, subscribe: false } } : {}),
      ...(downstreamUi ? { extensions: { [EXTENSION_ID]: downstreamUi } } : {}),
    },
    instructions: input.descriptor.instructions
      ?? `This is the member-authorized OpenWork Connect proxy for ${connection.name}. Tool names and resources are provided by that MCP server.`,
  })

  if (input.descriptor.capabilities.tools) {
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (await runtime.listTools(
        connection,
        input.operation.redirectUri,
        input.operation.member,
        input.operation.diagnosticReferenceId,
      )).filter((tool) => !evaluateToolPolicy(connection.toolPolicy, tool.name).blocked),
    }))
    server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const policy = evaluateToolPolicy(connection.toolPolicy, request.params.name)
      if (policy.blocked) throw new McpError(ErrorCode.InvalidRequest, `Tool ${request.params.name} is disabled by OpenWork Connect policy.`)
      return runtime.callTool({
        ...input.operation,
        toolName: request.params.name,
        args: toolArguments(request.params.arguments),
      })
    })
  }

  if (input.descriptor.capabilities.resources) {
    server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: await runtime.listResources(input.operation),
    }))
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: await runtime.listResourceTemplates(input.operation),
    }))
    server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => (
      runtime.readResource({ ...input.operation, uri: request.params.uri })
    ))
  }

  return server
}

async function jsonRpcRequestId(request: Request): Promise<string | number | null> {
  try {
    const value: unknown = await request.clone().json()
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const id = (value as { id?: unknown }).id
      if (typeof id === "string" || typeof id === "number") return id
    }
  } catch {
    // Preflight owns invalid JSON. A downstream failure without a readable id
    // still uses the protocol-defined null error id.
  }
  return null
}

export async function externalMcpProxyProtocolErrorResponse(
  request: Request,
  error: unknown,
  referenceId: string,
) {
  const diagnostic = externalMcpDiagnosticForResponse(error, referenceId, "MCP_INITIALIZE")
  console.error("external_mcp_proxy_initialization_failed", {
    referenceId: diagnostic.referenceId,
    phase: diagnostic.phase,
    code: diagnostic.code,
    retryable: diagnostic.retryable,
    actionOwner: diagnostic.actionOwner,
  })
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: await jsonRpcRequestId(request),
    error: {
      code: ErrorCode.InternalError,
      message: "The connected MCP server is not ready.",
      data: {
        error: "mcp_connection_unavailable",
        referenceId: diagnostic.referenceId,
        diagnosticCode: diagnostic.code,
        phase: diagnostic.phase,
        retryable: diagnostic.retryable,
        actionOwner: diagnostic.actionOwner,
        guidance: `${diagnostic.message} ${diagnostic.operatorAction}`,
      },
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

type ExternalMcpProxyRequestDependencies = {
  describe: typeof describeExternalMcpServer
  serve: (server: McpServer, context: Context) => Promise<Response | undefined>
}

const externalMcpProxyRequestDependencies: ExternalMcpProxyRequestDependencies = {
  describe: describeExternalMcpServer,
  serve: async (server, context) => {
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return transport.handleRequest(context)
  },
}

export async function handleExternalConnectionProxyRequest(input: {
  context: Context
  operation: ExternalMcpProxyOperation
  dependencies?: Partial<ExternalMcpProxyRequestDependencies>
}) {
  if (input.context.req.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } })
  }
  const dependencies = { ...externalMcpProxyRequestDependencies, ...input.dependencies }
  try {
    const descriptor = await dependencies.describe(input.operation)
    const server = createExternalConnectionProxyServer({ descriptor, operation: input.operation })
    const response = await dependencies.serve(server, input.context)
    return response ?? new Response(null, { status: 204 })
  } catch (error) {
    return externalMcpProxyProtocolErrorResponse(
      input.context.req.raw,
      error,
      input.operation.diagnosticReferenceId,
    )
  }
}

/**
 * Exposes one member-authorized Connect connection as one ordinary MCP
 * server. Names, schemas, resource URIs, UI metadata, results, and provider
 * errors stay on their native MCP protocol fields instead of being projected
 * through OpenWork-specific wrapper tools.
 *
 * Keeping a connection on its own endpoint also preserves the MCP Apps
 * same-server execution boundary and prevents collisions between two servers
 * that legitimately advertise the same tool name.
 */
export function registerExternalConnectionProxyRoutes<T extends { Variables: RequestIdVariables & Record<string, unknown> }>(app: Hono<T>) {
  app.all("/mcp/agent/connections/:connectionId", tokenRoute, async (c) => {
    const requestIdValue = c.get("requestId")
    const requestId = typeof requestIdValue === "string" ? requestIdValue : "unknown"
    const principal = await verifyMcpRequest(
      c.req.raw.headers,
      getMcpResourceContext(c.req.raw, "agent", requestId),
    )
    if (principal instanceof Response) return principal

    const preflightResponse = await preflightMcpJsonRpcRequest(c.req.raw, requestId)
    if (preflightResponse) return preflightResponse

    if (c.req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } })
    }

    let connectionId
    try {
      connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, "The MCP connection id is invalid.")
    }
    const organizationId = normalizeDenTypeId("organization", principal.organizationId)
    const member = await resolveMcpMemberIdentity({
      userId: principal.userId,
      organizationId,
    })
    if (!member) throw new McpError(ErrorCode.InvalidRequest, "The MCP connection is not available.")

    const connection = await getExternalMcpConnection({ organizationId, connectionId })
    const allowed = connection && await memberCanUseExternalMcpConnection({
      connectionId,
      orgMembershipId: member.orgMembershipId,
      teamIds: member.teamIds,
    })
    if (!connection || !allowed) throw new McpError(ErrorCode.InvalidRequest, "The MCP connection is not available.")

    const redirectUriBase = resolvePublicOrigin(c.req.raw, env.apiPublicUrl)
    const redirectUri = `${redirectUriBase}/v1/mcp-connections/${encodeURIComponent(connection.id)}/connect/callback`
    const downstreamMember = { orgMembershipId: member.orgMembershipId }
    const operation = {
      connection,
      redirectUri,
      member: downstreamMember,
      diagnosticReferenceId: requestId,
    }
    return handleExternalConnectionProxyRequest({ context: c, operation })
  })
}

export const STANDARD_MCP_APP_EXTENSION = {
  extensionId: EXTENSION_ID,
  mimeType: RESOURCE_MIME_TYPE,
} as const
