import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseLibraryPayload } from "../app/(den)/dashboard/_components/library-data";

test("parses Remote MCP Apps as first-class Library items", () => {
  expect(parseLibraryPayload({
    items: [{
      type: "app",
      id: "cob_01kzzzzzzzzzzzzzzzzzzzzzzz",
      pluginId: "plg_01kzzzzzzzzzzzzzzzzzzzzzzz",
      name: "Project Atlas",
      description: "Portable dashboard",
      sourceUrl: "https://example.test/project-atlas.html",
      status: "active",
      activeVersionId: "cov_01kzzzzzzzzzzzzzzzzzzzzzzz",
      state: "ready",
      edges: [{ kind: "org_wide" }],
      role: "viewer",
    }],
  })).toEqual([{
    type: "app",
    id: "cob_01kzzzzzzzzzzzzzzzzzzzzzzz",
    pluginId: "plg_01kzzzzzzzzzzzzzzzzzzzzzzz",
    name: "Project Atlas",
    description: "Portable dashboard",
    sourceUrl: "https://example.test/project-atlas.html",
    status: "active",
    activeVersionId: "cov_01kzzzzzzzzzzzzzzzzzzzzzzz",
    state: "ready",
    edges: [{ kind: "org_wide" }],
    role: "viewer",
  }]);
});

test("presents installed Remote MCP Apps inside their parent Plugin", () => {
  const components = join(import.meta.dir, "../app/(den)/dashboard/_components");
  const pluginData = readFileSync(join(components, "plugin-data.tsx"), "utf8");
  const pluginDetail = readFileSync(join(components, "plugin-detail-screen.tsx"), "utf8");
  expect(pluginData).toContain("export type PluginRemoteMcpApp");
  expect(pluginData).toContain("apps: PluginRemoteMcpApp[]");
  expect(pluginData).toContain('objectType === "app"');
  expect(pluginDetail).toContain("Remote Apps");
  expect(pluginDetail).toContain("installed inside this Plugin");
  expect(pluginDetail).toContain("getRemoteMcpAppRoute(orgSlug, app.id)");
});
