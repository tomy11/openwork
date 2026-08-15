import { afterAll, afterEach, beforeAll, expect, mock, setSystemTime, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import { generateSignedCookie } from "hono/cookie"
import { getDenSessionExpiresAt, getDenSessionRefreshCutoff } from "../src/session-lifetime.js"

type StoredSession = {
  session: {
    id: string
    token: string
    userId: string
    activeOrganizationId: string | null
    activeTeamId: string | null
    expiresAt: Date
    createdAt: Date
    updatedAt: Date
    ipAddress: string | null
    userAgent: string | null
  }
  user: {
    id: string
    name: string
    email: string
    emailVerified: boolean
    image: string | null
    createdAt: Date
    updatedAt: Date
  }
}

type CapturedUpdate = {
  values: unknown
  condition: unknown
}

const token = "desktop-bearer-session-token"
const userId = createDenTypeId("user")
const sessionId = createDenTypeId("session")
let stored: StoredSession | null = null
let cached: StoredSession | null = null
let cacheEnabled = false
let applyUpdates = true
let selects = 0
const updates: CapturedUpdate[] = []
const deletes: unknown[] = []
const cacheSets: StoredSession[] = []
const cacheDeletes: string[] = []
let sessionModule: typeof import("../src/session.js")

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sqlLeaves(value: unknown): Array<string | Date> {
  if (typeof value === "string" || value instanceof Date) {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(sqlLeaves)
  }
  if (!isRecord(value)) {
    return []
  }
  if (Array.isArray(value.queryChunks)) {
    return value.queryChunks.flatMap(sqlLeaves)
  }
  if (typeof value.name === "string") {
    return [value.name]
  }
  if ("value" in value) {
    return sqlLeaves(value.value)
  }
  return []
}

function sqlShape(condition: unknown) {
  return sqlLeaves(condition).filter((value) => typeof value === "string").join("")
}

function readDate(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null
  }
  const date = value[key]
  return date instanceof Date ? date : null
}

function makeStoredSession(input: { now: Date; updatedAt: Date; expiresAt: Date }): StoredSession {
  return {
    session: {
      id: sessionId,
      token,
      userId,
      activeOrganizationId: null,
      activeTeamId: null,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.updatedAt,
      ipAddress: null,
      userAgent: "OpenWork desktop",
    },
    user: {
      id: userId,
      name: "Desktop User",
      email: "desktop@example.com",
      emailVerified: true,
      image: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
  }
}

function selectRows(condition: unknown) {
  const current = stored
  const leaves = sqlLeaves(condition)
  const now = leaves.find((value) => value instanceof Date)
  if (!current || !leaves.includes(token) || !(now instanceof Date) || current.session.expiresAt <= now) {
    return []
  }
  return [current]
}

function applyCapturedUpdate(update: CapturedUpdate) {
  const current = stored
  const now = readDate(update.values, "updatedAt")
  const nextExpiresAt = readDate(update.values, "expiresAt")
  if (!current || !now || !nextExpiresAt) {
    return
  }

  const refreshCutoff = getDenSessionRefreshCutoff(now)
  if (
    current.session.expiresAt > now
    && current.session.expiresAt <= refreshCutoff
    && current.session.expiresAt < nextExpiresAt
  ) {
    stored = {
      ...current,
      session: {
        ...current.session,
        expiresAt: nextExpiresAt,
        updatedAt: now,
      },
    }
  }
}

function expectAtomicRenewal(update: CapturedUpdate, now: Date) {
  const shape = sqlShape(update.condition)
  const dates = sqlLeaves(update.condition).filter((value) => value instanceof Date)

  expect(shape).toContain(`token = ${token}`)
  expect(shape).toContain("expires_at > ")
  expect(shape).toContain("expires_at <= ")
  expect(shape).toContain("expires_at < ")
  expect(dates).toContainEqual(now)
  expect(dates).toContainEqual(getDenSessionRefreshCutoff(now))
  expect(dates).toContainEqual(getDenSessionExpiresAt(now))
}

beforeAll(async () => {
  seedRequiredEnv()

  mock.module("../src/auth.js", () => ({
    auth: {
      api: {
        getSession: () => Promise.resolve(null),
      },
      handler: () => Promise.resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 })),
    },
    DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
    DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
    DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
    DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
    DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
    DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
  }))

  mock.module("../src/db.js", () => ({
    db: {
      select: () => {
        selects += 1
        return {
          from: () => ({
            innerJoin: () => ({
              where: (condition: unknown) => ({
                limit: () => Promise.resolve(selectRows(condition)),
              }),
            }),
          }),
        }
      },
      update: () => ({
        set: (values: unknown) => ({
          where: (condition: unknown) => {
            const update = { values, condition }
            updates.push(update)
            if (applyUpdates) {
              applyCapturedUpdate(update)
            }
            return Promise.resolve()
          },
        }),
      }),
      delete: () => ({
        where: (condition: unknown) => {
          deletes.push(condition)
          if (sqlLeaves(condition).includes(token)) {
            stored = null
          }
          return Promise.resolve()
        },
      }),
    },
  }))

  mock.module("../src/cache.js", () => ({
    cache: {
      auth: {
        session: (requestedToken: string) => {
          const now = new Date()
          if (cacheEnabled && cached?.session.token === requestedToken && cached.session.expiresAt > now) {
            return Promise.resolve(cached)
          }
          selects += 1
          const loaded = stored?.session.token === requestedToken && stored.session.expiresAt > now ? stored : null
          if (cacheEnabled && loaded) {
            cached = loaded
            cacheSets.push(loaded)
          }
          return Promise.resolve(loaded)
        },
        deleteSession: (requestedToken: string) => {
          cacheDeletes.push(requestedToken)
          if (cached?.session.token === requestedToken) {
            cached = null
          }
          return Promise.resolve()
        },
      },
    },
  }))

  sessionModule = await import("../src/session.js")
})

afterEach(() => {
  setSystemTime()
  stored = null
  cached = null
  cacheEnabled = false
  applyUpdates = true
  selects = 0
  updates.length = 0
  deletes.length = 0
  cacheSets.length = 0
  cacheDeletes.length = 0
})

afterAll(() => {
  mock.restore()
})

test("active desktop bearer sessions roll forward after updateAge", async () => {
  const now = new Date("2026-07-09T12:00:00.000Z")
  setSystemTime(now)
  stored = makeStoredSession({
    now,
    updatedAt: now,
    expiresAt: new Date("2026-07-10T12:00:00.000Z"),
  })

  const resolved = await sessionModule.getRequestSession(new Headers({ authorization: `Bearer ${token}` }))

  expect(resolved?.session.expiresAt).toEqual(getDenSessionExpiresAt(now))
  expect(resolved?.session.updatedAt).toEqual(now)
  expect(updates).toHaveLength(1)
  expectAtomicRenewal(updates[0], now)
})

test("deleted and expired bearer sessions are never recreated", async () => {
  const now = new Date("2026-07-09T12:00:00.000Z")
  setSystemTime(now)

  await expect(sessionModule.getRequestSession(new Headers({ authorization: `Bearer ${token}` }))).resolves.toBeNull()
  expect(stored).toBeNull()
  expect(updates).toHaveLength(0)

  stored = makeStoredSession({
    now,
    updatedAt: new Date("2026-07-01T12:00:00.000Z"),
    expiresAt: now,
  })
  await expect(sessionModule.getRequestSession(new Headers({ authorization: `Bearer ${token}` }))).resolves.toBeNull()
  expect(stored?.session.expiresAt).toEqual(now)
  expect(updates).toHaveLength(0)
})

test("unknown bearer tokens never issue renewal updates", async () => {
  const now = new Date("2026-07-09T12:00:00.000Z")
  setSystemTime(now)
  stored = makeStoredSession({
    now,
    updatedAt: now,
    expiresAt: new Date("2026-07-10T12:00:00.000Z"),
  })

  await expect(sessionModule.getRequestSession(new Headers({
    authorization: "Bearer unknown-session-token",
  }))).resolves.toBeNull()
  expect(updates).toHaveLength(0)
})

test("cached desktop bearer sessions avoid the database lookup", async () => {
  const now = new Date("2026-07-09T12:00:00.000Z")
  setSystemTime(now)
  cacheEnabled = true
  cached = makeStoredSession({
    now,
    updatedAt: now,
    expiresAt: getDenSessionExpiresAt(now),
  })

  const resolved = await sessionModule.getRequestSession(new Headers({ authorization: `Bearer ${token}` }))

  expect(resolved?.session.id).toBe(sessionId)
  expect(selects).toBe(0)
  expect(updates).toHaveLength(0)
  expect(cacheSets).toHaveLength(0)
})

test("desktop bearer session cache misses populate from the database lookup", async () => {
  const now = new Date("2026-07-09T12:00:00.000Z")
  setSystemTime(now)
  cacheEnabled = true
  stored = makeStoredSession({
    now,
    updatedAt: now,
    expiresAt: getDenSessionExpiresAt(now),
  })

  const resolved = await sessionModule.getRequestSession(new Headers({ authorization: `Bearer ${token}` }))

  expect(resolved?.session.id).toBe(sessionId)
  expect(selects).toBe(1)
  expect(cacheSets).toHaveLength(1)
  expect(cached?.session.token).toBe(token)
})

test("signed Better Auth cookie sessions resolve through the Den cache", async () => {
  const now = new Date("2026-07-09T12:00:00.000Z")
  setSystemTime(now)
  stored = makeStoredSession({
    now,
    updatedAt: now,
    expiresAt: getDenSessionExpiresAt(now),
  })
  const app = new Hono()
  app.get("/session", async (c) => {
    const resolved = await sessionModule.getRequestSession(c.req.raw.headers, c)
    return c.json({ id: resolved?.session.id ?? null })
  })

  const cookie = await generateSignedCookie("better-auth.session_token", token, process.env.BETTER_AUTH_SECRET ?? "")
  const response = await app.request("/session", { headers: { cookie } })

  await expect(response.json()).resolves.toEqual({ id: sessionId })
  expect(selects).toBe(1)
})

test("unsigned Better Auth cookies are ignored", async () => {
  const now = new Date("2026-07-09T12:00:00.000Z")
  setSystemTime(now)
  stored = makeStoredSession({
    now,
    updatedAt: now,
    expiresAt: getDenSessionExpiresAt(now),
  })
  const app = new Hono()
  app.get("/session", async (c) => {
    const resolved = await sessionModule.getRequestSession(c.req.raw.headers, c)
    return c.json({ id: resolved?.session.id ?? null })
  })

  const response = await app.request("/session", { headers: { cookie: `better-auth.session_token=${token}` } })

  await expect(response.json()).resolves.toEqual({ id: null })
  expect(selects).toBe(0)
})

test("an older concurrent touch cannot shorten a newer expiry", async () => {
  const firstNow = new Date("2026-07-09T12:00:00.000Z")
  const secondNow = new Date("2026-07-09T12:01:00.000Z")
  stored = makeStoredSession({
    now: firstNow,
    updatedAt: new Date("2026-07-01T12:00:00.000Z"),
    expiresAt: new Date("2026-07-10T12:00:00.000Z"),
  })
  applyUpdates = false

  setSystemTime(firstNow)
  await sessionModule.getRequestSession(new Headers({ authorization: `Bearer ${token}` }))
  setSystemTime(secondNow)
  await sessionModule.getRequestSession(new Headers({ authorization: `Bearer ${token}` }))

  expect(updates).toHaveLength(2)
  expectAtomicRenewal(updates[0], firstNow)
  expectAtomicRenewal(updates[1], secondNow)
  applyCapturedUpdate(updates[1])
  applyCapturedUpdate(updates[0])
  expect(stored?.session.expiresAt).toEqual(getDenSessionExpiresAt(secondNow))
})

test("desktop bearer sign-out deletes the exact server session", async () => {
  const now = new Date("2026-07-09T12:00:00.000Z")
  stored = makeStoredSession({
    now,
    updatedAt: now,
    expiresAt: getDenSessionExpiresAt(now),
  })

  await expect(sessionModule.revokeBearerSession(new Headers())).resolves.toBe(false)
  expect(deletes).toHaveLength(0)

  await expect(sessionModule.revokeBearerSession(new Headers({ authorization: `Bearer ${token}` }))).resolves.toBe(true)
  expect(deletes).toHaveLength(1)
  expect(sqlShape(deletes[0])).toContain(`token = ${token}`)
  expect(stored).toBeNull()
  expect(cacheDeletes).toEqual([token])
})

test("only the Better Auth POST sign-out bypasses session resolution", () => {
  expect(sessionModule.shouldSkipRequestSession(new Request("http://den.local/api/auth/sign-out", {
    method: "POST",
  }))).toBe(true)
  expect(sessionModule.shouldSkipRequestSession(new Request("http://den.local/api/auth/sign-out", {
    method: "GET",
  }))).toBe(false)
  expect(sessionModule.shouldSkipRequestSession(new Request("http://den.local/v1/auth/sign-out", {
    method: "POST",
  }))).toBe(false)
})
