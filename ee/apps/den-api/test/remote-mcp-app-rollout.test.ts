import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probeRemoteMcpApps(value?: string) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify(env.remoteMcpAppsEnabled))
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      BETTER_AUTH_URL: "https://den.openwork.test",
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...(value === undefined ? {} : { DEN_REMOTE_MCP_APPS_ENABLED: value }),
    },
  })
}

test("Remote MCP Apps default on after the compatible Desktop rollout and remain disableable", () => {
  const unset = probeRemoteMcpApps()
  const disabled = probeRemoteMcpApps("false")
  const enabled = probeRemoteMcpApps("true")

  expect(unset.status).toBe(0)
  expect(unset.stdout.trim()).toBe("true")
  expect(disabled.status).toBe(0)
  expect(disabled.stdout.trim()).toBe("false")
  expect(enabled.status).toBe(0)
  expect(enabled.stdout.trim()).toBe("true")
})
