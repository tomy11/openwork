import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { expect, test } from "bun:test"

process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:3005"
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"

const {
  createExternalConnectionProxyServer,
  handleExternalConnectionProxyRequest,
} = await import("../src/mcp/external-connection-proxy.js")
const {
  externalMcpConnectionReadyForMember,
  readyExternalMcpConnectionsForMember,
} = await import("../src/capability-sources/external-mcp-connections.js")
const { ExternalMcpDiagnosticError } = await import("../src/capability-sources/external-mcp-diagnostics.js")
const { buildConnectMcpServerIndex } = await import("../src/mcp/connect-mcp-server-index.js")

const resourceUri = "ui://fixture/healthy.html"
const html = "<!doctype html><html><body>Healthy native MCP App</body></html>"
const connection = {
  id: "emc_01k28e8q8pf8r9sff9mhyqxved",
  organizationId: "org_01k28e8q8pf8r9sff9mhyqxved",
  name: "Fixture MCP",
  authType: "none",
  credentialMode: "shared",
  kind: "external_mcp",
  toolPolicy: null,
  oauthIssuerReviewRequiredAt: null,
} as never
const operation = {
  connection,
  redirectUri: "https://openwork.example/v1/mcp-connections/fixture/connect/callback",
  member: { orgMembershipId: "mem_01k28e8q8pf8r9sff9mhyqxved" },
  diagnosticReferenceId: "req_proxy_fixture",
} as never

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    listTools: async () => [{
      name: "open_fixture",
      description: "Open the fixture App.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { ui: { resourceUri, visibility: ["model", "app"] } },
    }],
    callTool: async () => ({
      content: [{ type: "text" as const, text: "Healthy fixture opened." }],
      structuredContent: { status: "healthy" },
    }),
    listResources: async () => [{ uri: resourceUri, name: "Healthy fixture", mimeType: "text/html;profile=mcp-app" }],
    listResourceTemplates: async () => [],
    readResource: async () => ({
      contents: [{ uri: resourceUri, mimeType: "text/html;profile=mcp-app", text: html }],
    }),
    ...overrides,
  } as never
}

function requestContext(request: Request) {
  return { req: { method: request.method, raw: request } } as never
}

async function withClient<T>(
  capabilities: Record<string, unknown>,
  run: (client: Client) => Promise<T>,
  runtimeOverrides: Record<string, unknown> = {},
) {
  const server = createExternalConnectionProxyServer({
    descriptor: {
      capabilities,
      serverInfo: { name: "fixture", version: "1.0.0" },
    } as never,
    operation,
    runtime: runtime(runtimeOverrides),
  })
  const client = new Client({ name: "proxy-test", version: "1.0.0" }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

test("tool-only downstream servers initialize and never register resource handlers", async () => {
  let resourceCalls = 0
  await withClient({ tools: {} }, async (client) => {
    const initialized = client.getServerCapabilities()
    expect(initialized?.tools).toEqual({ listChanged: false })
    expect(initialized?.resources).toBeUndefined()
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["open_fixture"])
    const called = await client.callTool({ name: "open_fixture", arguments: {} })
    expect(called.structuredContent).toEqual({ status: "healthy" })
    expect(resourceCalls).toBe(0)
  }, {
    listResources: async () => { resourceCalls += 1; return [] },
    listResourceTemplates: async () => { resourceCalls += 1; return [] },
    readResource: async () => { resourceCalls += 1; return { contents: [] } },
  })
})

test("a downstream server without resources initializes safely", async () => {
  await withClient({}, async (client) => {
    expect(client.getServerCapabilities()?.resources).toBeUndefined()
    expect(client.getServerCapabilities()?.tools).toBeUndefined()
  })
})

test("a healthy native MCP App preserves its resource and same-server app-visible tool", async () => {
  await withClient({
    tools: {},
    resources: {},
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  }, async (client) => {
    const tool = (await client.listTools()).tools[0]
    expect(tool?._meta).toMatchObject({ ui: { resourceUri, visibility: ["model", "app"] } })
    const resource = await client.readResource({ uri: resourceUri })
    expect(resource.contents[0]).toMatchObject({ uri: resourceUri, text: html })
    const called = await client.callTool({ name: "open_fixture", arguments: {} })
    expect(called.structuredContent).toEqual({ status: "healthy" })
  })
})

test("OAuth registration and network failures become sanitized protocol errors", async () => {
  const oauthFailure = new ExternalMcpDiagnosticError({
    referenceId: "req_oauth_registration",
    phase: "AUTH_CLIENT_REGISTRATION",
    category: "oauth_failure",
    code: "MCP_OAUTH_REGISTRATION_REJECTED",
    highestPassed: "reachable",
    retryable: false,
    actionOwner: "organization_admin",
    message: "The provider rejected OAuth client registration.",
    operatorAction: "Configure a provider-approved OAuth client, then reconnect the MCP connection.",
  })
  const oauthRequest = new Request("https://openwork.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "initialize", params: {} }),
  })
  const oauthResponse = await handleExternalConnectionProxyRequest({
    context: requestContext(oauthRequest),
    operation,
    dependencies: { describe: async () => { throw oauthFailure } },
  })
  expect(oauthResponse.status).toBe(200)
  const oauthPayload = await oauthResponse.json() as Record<string, unknown>
  expect(oauthPayload.id).toBe(41)
  expect(oauthPayload).toMatchObject({
    error: {
      code: -32603,
      data: {
        referenceId: "req_oauth_registration",
        diagnosticCode: "MCP_OAUTH_REGISTRATION_REJECTED",
        actionOwner: "organization_admin",
      },
    },
  })
  const serializedOauth = JSON.stringify(oauthPayload)
  expect(serializedOauth).toContain("provider-approved OAuth client")
  expect(serializedOauth).not.toContain("stack")
  expect(serializedOauth).not.toContain("providerResponse")

  const networkRequest = new Request("https://openwork.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "network", method: "initialize", params: {} }),
  })
  const networkResponse = await handleExternalConnectionProxyRequest({
    context: requestContext(networkRequest),
    operation: { ...operation, diagnosticReferenceId: "req_network" },
    dependencies: {
      describe: async () => ({ capabilities: {}, serverInfo: { name: "fixture", version: "1.0.0" } }) as never,
      serve: async () => { throw new Error("connect ECONNREFUSED token=do-not-expose") },
    },
  })
  expect(networkResponse.status).toBe(200)
  const networkPayload = await networkResponse.json() as Record<string, unknown>
  expect(networkPayload.id).toBe("network")
  expect(JSON.stringify(networkPayload)).not.toContain("do-not-expose")
  expect(JSON.stringify(networkPayload)).not.toContain("ECONNREFUSED")
})

test("unsupported GET requests never trigger downstream discovery", async () => {
  let discoveryCalls = 0
  const request = new Request("https://openwork.example/mcp", { method: "GET" })
  const response = await handleExternalConnectionProxyRequest({
    context: requestContext(request),
    operation,
    dependencies: {
      describe: async () => {
        discoveryCalls += 1
        throw new Error("unexpected discovery")
      },
    },
  })
  expect(response.status).toBe(405)
  expect(response.headers.get("allow")).toBe("POST")
  expect(discoveryCalls).toBe(0)
})

test("disconnected and issuer-blocked OAuth connections are not ready for the native server index", async () => {
  const memberId = "mem_01k28e8q8pf8r9sff9mhyqxved" as never
  const base = {
    ...connection,
    authType: "oauth",
    credentialMode: "shared",
    accessToken: null,
  } as never
  expect(await externalMcpConnectionReadyForMember(base, memberId)).toBe(false)
  expect(await externalMcpConnectionReadyForMember({ ...base, accessToken: "shared-token" } as never, memberId)).toBe(true)
  expect(await externalMcpConnectionReadyForMember({
    ...base,
    authType: "apikey",
    accessToken: null,
    apiKey: null,
  } as never, memberId)).toBe(false)
  expect(await externalMcpConnectionReadyForMember({
    ...base,
    authType: "apikey",
    accessToken: null,
    apiKey: "shared-api-key",
  } as never, memberId)).toBe(true)
  expect(await externalMcpConnectionReadyForMember({
    ...base,
    accessToken: "shared-token",
    oauthIssuerReviewRequiredAt: new Date(),
  } as never, memberId)).toBe(false)
  expect(await externalMcpConnectionReadyForMember({ ...base, credentialMode: "per_member" } as never, memberId, async () => ({
    current: true,
    value: null,
  }) as never)).toBe(false)
  expect(await externalMcpConnectionReadyForMember({ ...base, credentialMode: "per_member" } as never, memberId, async () => ({
    current: true,
    value: { accessToken: "member-token" },
  }) as never)).toBe(true)

  const ready = await readyExternalMcpConnectionsForMember([base], memberId)
  expect(buildConnectMcpServerIndex({
    connections: ready,
    publicOrigin: "https://openwork.example",
  }).servers).toEqual([])
})
