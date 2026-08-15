import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createEnterpriseMcpClient,
  type EnterpriseMcpConnection,
  type EnterpriseMcpOAuthAuthorizationHandle,
  type EnterpriseMcpOAuthClientRegistration,
  type EnterpriseMcpOAuthCredential,
  type EnterpriseMcpOAuthPersistence,
  type EnterpriseMcpPersistenceContext,
} from "@openwork/enterprise-mcp-client";
import { ApiError } from "./errors.js";
import { sanitizeDiagnosticString } from "./diagnostic-sanitizer.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  readRuntimeOpencodeConfig,
  runtimeMcpMap,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { assertLocalManagedMcpUrl, createLocalManagedMcpGuardedFetch } from "./local-managed-mcp-url-guard.js";

type LocalManagedMcpStatus = "needs_auth" | "connecting" | "connected" | "reconnect_required";

type StoredAuthorization = {
  revision: string;
  expiresAt: number;
  codeVerifier: string;
  clientRegistrationRevision?: string;
};

type StoredLocalManagedMcpConnection = {
  id: string;
  workspaceId: string;
  name: string;
  serverUrl: string;
  enabled: boolean;
  oauth: {
    applicationType: "native" | "web";
    requestedScopes?: string[];
    authorizationServerIssuer?: string;
    clientId?: string;
    clientSecret?: string;
  };
  status: LocalManagedMcpStatus;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  clientRegistration?: EnterpriseMcpOAuthClientRegistration;
  credential?: EnterpriseMcpOAuthCredential;
  authorizations: Record<string, StoredAuthorization>;
  discovery?: OAuthDiscoveryState;
};

type LocalManagedMcpVault = {
  schemaVersion: 1;
  connections: Record<string, StoredLocalManagedMcpConnection>;
};

type VaultEnvelope = {
  schemaVersion: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

export type LocalManagedMcpPublicConnection = {
  name: string;
  serverUrl: string;
  enabled: boolean;
  status: LocalManagedMcpStatus;
  lastError: string | null;
  hasCredential: boolean;
  updatedAt: number;
};

export type CreateLocalManagedMcpInput = {
  workspaceId: string;
  name: string;
  serverUrl: string;
  oauth: {
    applicationType?: "native" | "web";
    requestedScopes?: string[];
    authorizationServerIssuer?: string;
    clientId?: string;
    clientSecret?: string;
  };
};

const VAULT_AAD = Buffer.from("openwork-local-managed-mcp-v1", "utf8");
const vaultQueueByPath = new Map<string, Promise<void>>();
const vaultKeyByConfig = new WeakMap<ServerConfig, Promise<Buffer>>();
const gatewaySecretByConfig = new WeakMap<ServerConfig, Buffer>();
const guardedFetch = createLocalManagedMcpGuardedFetch();

function emptyVault(): LocalManagedMcpVault {
  return { schemaVersion: 1, connections: {} };
}

function vaultPath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "local-managed-mcp-vault.json");
}

function secureVaultStorageUnavailable(): ApiError {
  return new ApiError(
    503,
    "managed_mcp_secure_storage_unavailable",
    "Secure storage for OpenWork-managed MCP credentials is unavailable. Start through OpenWork Desktop or set OPENWORK_ENCRYPTION_KEY.",
  );
}

async function resolveVaultKey(config: ServerConfig): Promise<Buffer> {
  if (config.localManagedMcpVaultKey) {
    try {
      const key = Buffer.from(await config.localManagedMcpVaultKey());
      if (key.byteLength !== 32) throw new Error("invalid vault key length");
      return key;
    } catch {
      throw secureVaultStorageUnavailable();
    }
  }
  const configured = process.env.OPENWORK_ENCRYPTION_KEY?.trim();
  if (configured) return createHash("sha256").update(configured).digest();
  throw secureVaultStorageUnavailable();
}

async function vaultKey(config: ServerConfig): Promise<Buffer> {
  let pending = vaultKeyByConfig.get(config);
  if (!pending) {
    pending = resolveVaultKey(config);
    vaultKeyByConfig.set(config, pending);
  }
  try {
    return Buffer.from(await pending);
  } catch (error) {
    vaultKeyByConfig.delete(config);
    throw error;
  }
}

function isVaultEnvelope(value: unknown): value is VaultEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && record.algorithm === "aes-256-gcm"
    && typeof record.iv === "string"
    && typeof record.tag === "string"
    && typeof record.data === "string";
}

function isVault(value: unknown): value is LocalManagedMcpVault {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.connections === "object"
    && record.connections !== null
    && !Array.isArray(record.connections);
}

async function readVault(config: ServerConfig): Promise<LocalManagedMcpVault> {
  try {
    const envelopeValue: unknown = JSON.parse(await readFile(vaultPath(config), "utf8"));
    if (!isVaultEnvelope(envelopeValue)) throw new Error("The local managed MCP vault envelope is invalid.");
    const key = await vaultKey(config);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelopeValue.iv, "base64"));
    decipher.setAAD(VAULT_AAD);
    decipher.setAuthTag(Buffer.from(envelopeValue.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelopeValue.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const value: unknown = JSON.parse(plaintext);
    if (!isVault(value)) throw new Error("The local managed MCP vault payload is invalid.");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyVault();
    throw error;
  }
}

async function writeVault(config: ServerConfig, vault: LocalManagedMcpVault): Promise<void> {
  const path = vaultPath(config);
  const key = await vaultKey(config);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(VAULT_AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(vault), "utf8"), cipher.final()]);
  const envelope: VaultEnvelope = {
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function withVaultMutation<T>(
  config: ServerConfig,
  mutate: (vault: LocalManagedMcpVault) => Promise<T> | T,
  shouldPersist: (result: T) => boolean = () => true,
): Promise<T> {
  const path = vaultPath(config);
  const previous = vaultQueueByPath.get(path) ?? Promise.resolve();
  let resolveCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  vaultQueueByPath.set(path, previous.catch(() => undefined).then(() => current));
  await previous.catch(() => undefined);
  try {
    const vault = await readVault(config);
    const result = await mutate(vault);
    if (shouldPersist(result)) await writeVault(config, vault);
    return result;
  } finally {
    resolveCurrent?.();
  }
}

async function withVaultRead<T>(config: ServerConfig, read: (vault: LocalManagedMcpVault) => T): Promise<T> {
  await (vaultQueueByPath.get(vaultPath(config)) ?? Promise.resolve()).catch(() => undefined);
  return read(await readVault(config));
}

function connectionKey(workspaceId: string, name: string): string {
  return `${workspaceId.length}:${workspaceId}${name}`;
}

function requireConnection(vault: LocalManagedMcpVault, workspaceId: string, name: string): StoredLocalManagedMcpConnection {
  const connection = vault.connections[connectionKey(workspaceId, name)];
  if (!connection) throw new ApiError(404, "managed_mcp_not_found", `Managed MCP ${name} was not found`);
  return connection;
}

function publicConnection(connection: StoredLocalManagedMcpConnection): LocalManagedMcpPublicConnection {
  return {
    name: connection.name,
    serverUrl: connection.serverUrl,
    enabled: connection.enabled,
    status: connection.status,
    lastError: connection.lastError ?? null,
    hasCredential: Boolean(connection.credential),
    updatedAt: connection.updatedAt,
  };
}

function authorizationStorageKey(key: Buffer, authorizationId: string): string {
  return createHmac("sha256", key).update(authorizationId).digest("base64url");
}

function ensurePersistenceContext(context: EnterpriseMcpPersistenceContext): void {
  if (context.signal.aborted || Date.now() >= context.commitExpiresAt) {
    throw new Error("The managed MCP persistence deadline expired.");
  }
}

function createPersistence(config: ServerConfig, workspaceId: string, name: string): EnterpriseMcpOAuthPersistence {
  const loadConnection = () => withVaultRead(config, (vault) => requireConnection(vault, workspaceId, name));
  return {
    clientRegistrations: {
      load: async (context) => {
        ensurePersistenceContext(context);
        const connection = await loadConnection();
        if (connection.oauth.clientId) {
          const clientInformation: OAuthClientInformationMixed = {
            client_id: connection.oauth.clientId,
            ...(connection.oauth.clientSecret ? { client_secret: connection.oauth.clientSecret } : {}),
            token_endpoint_auth_method: connection.oauth.clientSecret ? "client_secret_post" : "none",
          };
          return { clientInformation, revision: "pre-registered:1", source: "pre-registered" };
        }
        return connection.clientRegistration;
      },
      save: async ({ context, clientInformation, expiresAt, source }) => {
        ensurePersistenceContext(context);
        return withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          if (connection.clientRegistration) return connection.clientRegistration;
          const registration: EnterpriseMcpOAuthClientRegistration = {
            clientInformation,
            revision: randomUUID(),
            source,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          };
          connection.clientRegistration = registration;
          connection.updatedAt = Date.now();
          return registration;
        });
      },
      invalidate: async ({ context }) => {
        ensurePersistenceContext(context);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          delete connection.clientRegistration;
          connection.updatedAt = Date.now();
        });
      },
    },
    credentials: {
      load: async (context) => {
        ensurePersistenceContext(context);
        return (await loadConnection()).credential;
      },
      save: async ({ context, tokens, expiresAt, source, authorization, clientRegistrationRevision, expectedCredentialRevision }) => {
        ensurePersistenceContext(context);
        await withVaultMutation(config, async (vault) => {
          ensurePersistenceContext(context);
          const connection = requireConnection(vault, workspaceId, name);
          if (source === "refresh" && expectedCredentialRevision !== connection.credential?.revision) {
            throw new Error("The managed MCP credential changed during refresh.");
          }
          if (source === "authorization-code") {
            if (!authorization) throw new Error("The managed MCP authorization transaction is missing.");
            const key = await vaultKey(config);
            const storedKey = authorizationStorageKey(key, authorization.id);
            const stored = connection.authorizations[storedKey];
            if (!stored || stored.revision !== authorization.revision) {
              throw new Error("The managed MCP authorization transaction was already consumed.");
            }
            if (stored.clientRegistrationRevision !== clientRegistrationRevision) {
              throw new Error("The managed MCP OAuth client changed during authorization.");
            }
            delete connection.authorizations[storedKey];
          }
          connection.credential = {
            tokens,
            revision: randomUUID(),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          };
          connection.status = "connected";
          delete connection.lastError;
          connection.updatedAt = Date.now();
        });
      },
      invalidate: async ({ context }) => {
        ensurePersistenceContext(context);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          delete connection.credential;
          connection.status = "reconnect_required";
          connection.updatedAt = Date.now();
        });
      },
    },
    authorizations: {
      begin: async ({ context, id, codeVerifier, expiresAt, clientRegistrationRevision }) => {
        ensurePersistenceContext(context);
        const key = await vaultKey(config);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          connection.authorizations[authorizationStorageKey(key, id)] = {
            revision: randomUUID(),
            expiresAt,
            codeVerifier,
            ...(clientRegistrationRevision === undefined ? {} : { clientRegistrationRevision }),
          };
          connection.updatedAt = Date.now();
        });
      },
      load: async ({ context, id }) => {
        ensurePersistenceContext(context);
        const key = await vaultKey(config);
        const stored = await withVaultRead(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          return connection.authorizations[authorizationStorageKey(key, id)];
        });
        if (!stored) return undefined;
        const handle: EnterpriseMcpOAuthAuthorizationHandle = {
          id,
          revision: stored.revision,
          expiresAt: stored.expiresAt,
          ...(stored.clientRegistrationRevision === undefined ? {} : { clientRegistrationRevision: stored.clientRegistrationRevision }),
        };
        return { handle, codeVerifier: stored.codeVerifier };
      },
      invalidate: async ({ context, id }) => {
        ensurePersistenceContext(context);
        const key = await vaultKey(config);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          delete connection.authorizations[authorizationStorageKey(key, id)];
          connection.updatedAt = Date.now();
        });
      },
    },
    discovery: {
      load: async (context) => {
        ensurePersistenceContext(context);
        return (await loadConnection()).discovery;
      },
      save: async ({ context, state }) => {
        ensurePersistenceContext(context);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          connection.discovery = state;
          connection.updatedAt = Date.now();
        });
      },
      invalidate: async ({ context }) => {
        ensurePersistenceContext(context);
        await withVaultMutation(config, (vault) => {
          const connection = requireConnection(vault, workspaceId, name);
          delete connection.discovery;
          connection.updatedAt = Date.now();
        });
      },
    },
  };
}

async function enterpriseConnection(config: ServerConfig, workspaceId: string, name: string): Promise<EnterpriseMcpConnection> {
  const connection = await withVaultRead(config, (vault) => requireConnection(vault, workspaceId, name));
  return {
    id: connection.id,
    serverUrl: connection.serverUrl,
    authorization: {
      type: "oauth",
      persistence: createPersistence(config, workspaceId, name),
      configuration: {
        applicationType: connection.oauth.applicationType,
        ...(connection.oauth.requestedScopes ? { requestedScopes: connection.oauth.requestedScopes } : {}),
        ...(connection.oauth.authorizationServerIssuer ? { authorizationServerIssuer: connection.oauth.authorizationServerIssuer } : {}),
      },
    },
  };
}

function enterpriseClient() {
  return createEnterpriseMcpClient({
    fetch: guardedFetch,
    clientName: "OpenWork Local MCP Gateway",
    clientVersion: "1.0.0",
    operationTimeoutMs: 45_000,
  });
}

function serverOrigin(config: ServerConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

export function localManagedMcpCallbackUrl(config: ServerConfig): string {
  return `${serverOrigin(config)}/mcp/oauth/callback`;
}

function gatewaySecret(config: ServerConfig): Buffer {
  const existing = gatewaySecretByConfig.get(config);
  if (existing) return existing;
  const secret = randomBytes(32);
  gatewaySecretByConfig.set(config, secret);
  return secret;
}

function gatewayToken(config: ServerConfig, workspaceId: string, name: string): string {
  return createHmac("sha256", gatewaySecret(config)).update(`${workspaceId}\0${name}`).digest("base64url");
}

function gatewayPath(workspaceId: string, name: string): string {
  return `/mcp/managed/${encodeURIComponent(workspaceId)}/${encodeURIComponent(name)}`;
}

function runtimeConfig(config: ServerConfig, workspaceId: string, name: string, enabled: boolean): Record<string, unknown> {
  return {
    type: "remote",
    url: `${serverOrigin(config)}${gatewayPath(workspaceId, name)}`,
    enabled,
    headers: { Authorization: `Bearer ${gatewayToken(config, workspaceId, name)}` },
    oauth: false,
  };
}

async function writeManagedRuntimeEntry(config: ServerConfig, workspaceId: string, name: string, enabled: boolean): Promise<void> {
  await writeRuntimeOpencodeConfig(config, workspaceId, (current) => ({
    ...current,
    mcp: { ...runtimeMcpMap(current), [name]: runtimeConfig(config, workspaceId, name, enabled) },
  }));
}

async function removeManagedRuntimeEntry(config: ServerConfig, workspaceId: string, name: string): Promise<void> {
  await writeRuntimeOpencodeConfig(config, workspaceId, (current) => {
    const mcp = { ...runtimeMcpMap(current) };
    delete mcp[name];
    return { ...current, mcp };
  });
}

export async function reconcileLocalManagedMcpRuntimeEntries(config: ServerConfig): Promise<void> {
  const connections = await withVaultRead(config, (vault) => Object.values(vault.connections));
  for (const connection of connections) {
    if (!config.workspaces.some((workspace) => workspace.id === connection.workspaceId)) continue;
    await writeManagedRuntimeEntry(config, connection.workspaceId, connection.name, connection.enabled);
  }
}

export async function createLocalManagedMcpConnection(config: ServerConfig, input: CreateLocalManagedMcpInput): Promise<LocalManagedMcpPublicConnection> {
  const serverUrl = new URL(input.serverUrl).toString();
  await assertLocalManagedMcpUrl(serverUrl);
  const now = Date.now();
  const connection = await withVaultMutation(config, (vault) => {
    const key = connectionKey(input.workspaceId, input.name);
    if (vault.connections[key]) {
      throw new ApiError(409, "managed_mcp_exists", `Managed MCP ${input.name} already exists`);
    }
    const stored: StoredLocalManagedMcpConnection = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      serverUrl,
      enabled: true,
      oauth: {
        applicationType: input.oauth.applicationType ?? "native",
        ...(input.oauth.requestedScopes?.length ? { requestedScopes: [...new Set(input.oauth.requestedScopes)] } : {}),
        ...(input.oauth.authorizationServerIssuer ? { authorizationServerIssuer: input.oauth.authorizationServerIssuer } : {}),
        ...(input.oauth.clientId ? { clientId: input.oauth.clientId } : {}),
        ...(input.oauth.clientSecret ? { clientSecret: input.oauth.clientSecret } : {}),
      },
      status: "needs_auth",
      createdAt: now,
      updatedAt: now,
      authorizations: {},
    };
    vault.connections[key] = stored;
    return stored;
  });
  await writeManagedRuntimeEntry(config, input.workspaceId, input.name, true);
  return publicConnection(connection);
}

export async function listLocalManagedMcpConnections(config: ServerConfig, workspaceId: string): Promise<LocalManagedMcpPublicConnection[]> {
  return withVaultRead(config, (vault) => Object.values(vault.connections)
    .filter((connection) => connection.workspaceId === workspaceId)
    .map(publicConnection)
    .sort((left, right) => left.name.localeCompare(right.name)));
}

export async function getLocalManagedMcpConnection(config: ServerConfig, workspaceId: string, name: string): Promise<LocalManagedMcpPublicConnection> {
  return withVaultRead(config, (vault) => publicConnection(requireConnection(vault, workspaceId, name)));
}

type AuthorizationStatePayload = {
  version: 1;
  workspaceId: string;
  name: string;
  connectionId: string;
  redirectUri: string;
  expiresAt: number;
  nonce: string;
};

function encodeStatePayload(payload: AuthorizationStatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function createAuthorizationState(config: ServerConfig, workspaceId: string, name: string): Promise<string> {
  const connection = await withVaultRead(config, (vault) => requireConnection(vault, workspaceId, name));
  const encoded = encodeStatePayload({
    version: 1,
    workspaceId,
    name,
    connectionId: connection.id,
    redirectUri: localManagedMcpCallbackUrl(config),
    expiresAt: Date.now() + 10 * 60_000,
    nonce: randomBytes(24).toString("base64url"),
  });
  const signature = createHmac("sha256", await vaultKey(config)).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function verifyAuthorizationState(config: ServerConfig, state: string): Promise<AuthorizationStatePayload> {
  const [encoded, signature, extra] = state.split(".");
  if (!encoded || !signature || extra) throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid");
  const expected = createHmac("sha256", await vaultKey(config)).update(encoded).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid");
  }
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid");
  }
  const payload = value as Partial<AuthorizationStatePayload>;
  if (payload.version !== 1
    || typeof payload.workspaceId !== "string"
    || typeof payload.name !== "string"
    || typeof payload.connectionId !== "string"
    || typeof payload.redirectUri !== "string"
    || typeof payload.expiresAt !== "number"
    || typeof payload.nonce !== "string"
    || payload.expiresAt <= Date.now()) {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state is invalid or expired");
  }
  const connection = await withVaultRead(config, (vault) => requireConnection(vault, payload.workspaceId!, payload.name!));
  if (connection.id !== payload.connectionId || payload.redirectUri !== localManagedMcpCallbackUrl(config)) {
    throw new ApiError(400, "managed_mcp_oauth_state_invalid", "OAuth state does not match this connection");
  }
  return payload as AuthorizationStatePayload;
}

async function updateConnectionStatus(
  config: ServerConfig,
  workspaceId: string,
  name: string,
  status: LocalManagedMcpStatus,
  lastError?: string,
): Promise<void> {
  await withVaultMutation(config, (vault) => {
    const connection = requireConnection(vault, workspaceId, name);
    connection.status = status;
    connection.updatedAt = Date.now();
    if (lastError) {
      connection.lastError = sanitizeDiagnosticString(lastError)
        .replace(/([?&](?:access_token|refresh_token|client_secret|code|state)=)[^&\s]+/gi, "$1[REDACTED]")
        .replace(/("(?:access_token|refresh_token|client_secret|code|state)"\s*:\s*")[^"]+/gi, "$1[REDACTED]")
        .slice(0, 500);
    }
    else delete connection.lastError;
  });
}

async function verifyTools(config: ServerConfig, workspaceId: string, name: string, redirectUri: string): Promise<void> {
  const connection = await enterpriseConnection(config, workspaceId, name);
  await enterpriseClient().listTools({ connection, redirectUri });
  await updateConnectionStatus(config, workspaceId, name, "connected");
}

async function markReconnectWhenCredentialIsGone(
  config: ServerConfig,
  workspaceId: string,
  name: string,
  error: unknown,
  fallback: string,
): Promise<boolean> {
  const hasCredential = await withVaultRead(config, (vault) => Boolean(requireConnection(vault, workspaceId, name).credential));
  if (!hasCredential) {
    await updateConnectionStatus(config, workspaceId, name, "reconnect_required", error instanceof Error ? error.message : fallback);
  }
  return !hasCredential;
}

export async function startLocalManagedMcpAuthorization(config: ServerConfig, workspaceId: string, name: string) {
  await withVaultMutation(config, (vault) => {
    const connection = requireConnection(vault, workspaceId, name);
    connection.enabled = true;
    connection.updatedAt = Date.now();
  });
  await updateConnectionStatus(config, workspaceId, name, "connecting");
  await writeManagedRuntimeEntry(config, workspaceId, name, true);
  const authorizationId = await createAuthorizationState(config, workspaceId, name);
  const redirectUri = localManagedMcpCallbackUrl(config);
  try {
    const connection = await enterpriseConnection(config, workspaceId, name);
    const result = await enterpriseClient().connect({ connection, redirectUri, authorizationId });
    if (result.status === "connected") {
      await verifyTools(config, workspaceId, name, redirectUri);
      return { status: "connected" as const };
    }
    await updateConnectionStatus(config, workspaceId, name, "needs_auth");
    return { status: "needs_auth" as const, authorizeUrl: result.authorizeUrl };
  } catch (error) {
    await updateConnectionStatus(config, workspaceId, name, "reconnect_required", error instanceof Error ? error.message : "Connection failed");
    throw error;
  }
}

export async function completeLocalManagedMcpAuthorization(
  config: ServerConfig,
  state: string,
  code: string,
): Promise<{ connection: LocalManagedMcpPublicConnection; workspaceId: string }> {
  const payload = await verifyAuthorizationState(config, state);
  try {
    const connection = await enterpriseConnection(config, payload.workspaceId, payload.name);
    await enterpriseClient().completeAuthorization({
      connection,
      redirectUri: payload.redirectUri,
      code,
      authorizationId: state,
    });
    await verifyTools(config, payload.workspaceId, payload.name, payload.redirectUri);
    await writeManagedRuntimeEntry(config, payload.workspaceId, payload.name, true);
    return {
      connection: await getLocalManagedMcpConnection(config, payload.workspaceId, payload.name),
      workspaceId: payload.workspaceId,
    };
  } catch (error) {
    await updateConnectionStatus(config, payload.workspaceId, payload.name, "reconnect_required", error instanceof Error ? error.message : "Authorization failed");
    throw error;
  }
}

export async function setLocalManagedMcpEnabled(
  config: ServerConfig,
  workspaceId: string,
  name: string,
  enabled: boolean,
): Promise<boolean> {
  const updated = await withVaultMutation(config, (vault) => {
    const connection = vault.connections[connectionKey(workspaceId, name)];
    if (!connection) return false;
    connection.enabled = enabled;
    connection.updatedAt = Date.now();
    return true;
  }, (changed) => changed);
  if (updated) await writeManagedRuntimeEntry(config, workspaceId, name, enabled);
  return updated;
}

export async function disconnectLocalManagedMcp(config: ServerConfig, workspaceId: string, name: string): Promise<boolean> {
  const exists = await withVaultRead(config, (vault) => Boolean(vault.connections[connectionKey(workspaceId, name)]));
  if (!exists) return false;
  await withVaultMutation(config, (vault) => {
    const connection = requireConnection(vault, workspaceId, name);
    delete connection.credential;
    connection.authorizations = {};
    connection.enabled = false;
    connection.status = "needs_auth";
    delete connection.lastError;
    connection.updatedAt = Date.now();
  });
  await writeManagedRuntimeEntry(config, workspaceId, name, false);
  return true;
}

export async function deleteLocalManagedMcp(config: ServerConfig, workspaceId: string, name: string): Promise<boolean> {
  const removed = await withVaultMutation(config, (vault) => {
    const key = connectionKey(workspaceId, name);
    if (!vault.connections[key]) return false;
    delete vault.connections[key];
    return true;
  }, (changed) => changed);
  if (removed) await removeManagedRuntimeEntry(config, workspaceId, name);
  return removed;
}

function bearerToken(request: Request): string | null {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

export function authorizeLocalManagedMcpGateway(config: ServerConfig, request: Request, workspaceId: string, name: string): boolean {
  const supplied = bearerToken(request);
  if (!supplied) return false;
  const expected = gatewayToken(config, workspaceId, name);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(suppliedBytes, expectedBytes);
}

export async function handleLocalManagedMcpGateway(
  config: ServerConfig,
  request: Request,
  workspaceId: string,
  name: string,
): Promise<Response> {
  if (!authorizeLocalManagedMcpGateway(config, request, workspaceId, name)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const stored = await withVaultRead(config, (vault) => requireConnection(vault, workspaceId, name));
  if (!stored.enabled) {
    return new Response(JSON.stringify({ error: "connection_disabled" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  const redirectUri = localManagedMcpCallbackUrl(config);
  const server = new Server(
    { name: `openwork-local-${name}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const connection = await enterpriseConnection(config, workspaceId, name);
      return { tools: await enterpriseClient().listTools({ connection, redirectUri }) };
    } catch (error) {
      const reconnect = await markReconnectWhenCredentialIsGone(config, workspaceId, name, error, "Tool discovery failed");
      throw new McpError(
        ErrorCode.InternalError,
        reconnect
          ? "This MCP connection needs to be reconnected in OpenWork."
          : "This MCP tool catalog could not be loaded. Retry the request.",
      );
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      const connection = await enterpriseConnection(config, workspaceId, name);
      const args = call.params.arguments ?? {};
      return await enterpriseClient().callTool({
        connection,
        redirectUri,
        toolName: call.params.name,
        arguments: args,
      });
    } catch (error) {
      const reconnect = await markReconnectWhenCredentialIsGone(config, workspaceId, name, error, "Tool execution failed");
      throw new McpError(
        ErrorCode.InternalError,
        reconnect
          ? "This MCP tool could not run. Reconnect it in OpenWork and retry."
          : "This MCP tool could not run. Review the tool input or provider response and retry.",
      );
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${config.port}`, `localhost:${config.port}`],
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
