import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const sessionId = createDenTypeId("session")
const sessionToken = "cached-session-token"
const cachedValues = new Map<string, string>()
const setCalls: Array<{ key: string; value: string; mode: string; ttl: number }> = []
const deleteCalls: string[] = []
let selectCount = 0
let authSelectCount = 0
let authLivenessCount = 0
let authSessionExpiresAt = new Date("2026-08-10T14:00:00.000Z")
let authSessionLive = true
let cacheModule: typeof import("../src/cache.js")
let restoreCacheDependencies: (() => void) | null = null

const redis = {
  get: (key: string) => Promise.resolve(cachedValues.get(key) ?? null),
  set: (key: string, value: string, mode: string, ttl: number) => {
    setCalls.push({ key, value, mode, ttl })
    cachedValues.set(key, value)
    return Promise.resolve("OK")
  },
  del: (key: string) => {
    deleteCalls.push(key)
    cachedValues.delete(key)
    return Promise.resolve(1)
  },
}

function memberRows() {
  const now = new Date("2026-08-10T12:00:00.000Z")
  return [{
    id: memberId,
    userId,
    inviteId: null,
    role: "member",
    createdAt: now,
    joinedAt: now,
    user: {
      id: userId,
      email: "member@example.com",
      name: "Member User",
      image: null,
    },
    isOwner: false,
  }]
}

function authSession() {
  const now = new Date("2026-08-10T12:00:00.000Z")
  return {
    session: {
      id: sessionId,
      token: sessionToken,
      userId,
      activeOrganizationId: null,
      activeTeamId: null,
      expiresAt: authSessionExpiresAt,
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: userId,
      name: "Session User",
      email: "session@example.com",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  }
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"

  cacheModule = await import("../src/cache.js")
  restoreCacheDependencies = cacheModule.setCacheDependenciesForTest({
    redis,
    orgMembersLoader: () => {
      selectCount += 1
      return Promise.resolve(memberRows())
    },
    authSessionLoader: () => {
      authSelectCount += 1
      return Promise.resolve(authSession())
    },
    authSessionLivenessLoader: () => {
      authLivenessCount += 1
      return Promise.resolve(authSessionLive ? {
        session: authSession().session,
        userUpdatedAt: authSession().user.updatedAt,
      } : null)
    },
  })
})

beforeEach(() => {
  cachedValues.clear()
  setCalls.length = 0
  deleteCalls.length = 0
  selectCount = 0
  authSelectCount = 0
  authLivenessCount = 0
  authSessionExpiresAt = new Date("2026-08-10T14:00:00.000Z")
  authSessionLive = true
  setSystemTime(new Date("2026-08-10T12:00:00.000Z"))
})

afterAll(() => {
  setSystemTime()
  restoreCacheDependencies?.()
})

test("cache.org.members stores and reuses org member query results", async () => {
  const first = await cacheModule.cache.org.members(organizationId)
  const second = await cacheModule.cache.org.members(organizationId)

  expect(first).toEqual(second)
  expect(first).toHaveLength(1)
  expect(first[0].id).toBe(memberId)
  expect(selectCount).toBe(1)
  expect(setCalls).toHaveLength(1)
  expect(setCalls[0]).toMatchObject({
    key: `cache:org:members:${organizationId}`,
    mode: "EX",
    ttl: 60,
  })
})

test("cache.auth.session uses the Den key and caps Redis TTL at one hour", async () => {
  const first = await cacheModule.cache.auth.session(sessionToken)
  const second = await cacheModule.cache.auth.session(sessionToken)

  expect(first).toEqual(second)
  expect(first?.session.id).toBe(sessionId)
  expect(authSelectCount).toBe(1)
  expect(authLivenessCount).toBe(1)
  expect(setCalls).toHaveLength(1)
  expect(setCalls[0]).toMatchObject({
    key: `cache:auth:session:${sessionToken}`,
    mode: "EX",
    ttl: 3600,
  })
})

test("cache.auth.session rejects stale Redis entries after database revocation", async () => {
  await cacheModule.cache.auth.session(sessionToken)
  authSessionLive = false

  const resolved = await cacheModule.cache.auth.session(sessionToken)

  expect(resolved).toBeNull()
  expect(deleteCalls).toEqual([`cache:auth:session:${sessionToken}`])
})

test("cache.auth.session limits TTL to the remaining session lifetime", async () => {
  authSessionExpiresAt = new Date("2026-08-10T12:30:00.000Z")

  await cacheModule.cache.auth.session(sessionToken)

  expect(setCalls[0]?.ttl).toBe(1800)
})

test("cache.auth.deleteSession invalidates the exact Den cache key", async () => {
  await cacheModule.cache.auth.session(sessionToken)
  await cacheModule.cache.auth.deleteSession(sessionToken)

  expect(deleteCalls).toEqual([`cache:auth:session:${sessionToken}`])
})

test("cache.auth.session falls back to the database loader without Redis", async () => {
  const restore = cacheModule.setCacheDependenciesForTest({ redis: null })
  try {
    const resolved = await cacheModule.cache.auth.session(sessionToken)
    expect(resolved?.session.token).toBe(sessionToken)
    expect(authSelectCount).toBe(1)
    expect(setCalls).toHaveLength(0)
  } finally {
    restore()
  }
})
