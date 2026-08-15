import { expect } from "vitest";
import { screenshot, validate } from "@openwork/fraimz";
import {
  createOrgConnection,
  control,
  denFetch,
  evalIn,
  go,
  readComposerState,
  visibleText,
  waitFor,
  waitForAssistantReply,
  waitForText,
  waitUntilInteractive,
  writeComposerText,
} from "@openwork/behaviors";
import { app, mcpMock, needs, server, test } from "@openwork/testkit";
import type { Surface } from "@openwork/cdp";

process.env.MOCK_ALLOW_UNAUTHENTICATED_MCP = "1";

const requirements = {
  model: "tool-capable" as const,
  optIn: ["OPENWORK_EVAL_APP_SPECS", "OPENWORK_EVAL_SAVED_SCRIPT_AUTOMATIONS_SPEC"],
};

async function setField(surface: Surface, label: string, value: string): Promise<void> {
  const changed = await evalIn(surface, `(() => {
    const labels = [...document.querySelectorAll('label')];
    const label = labels.find((candidate) => (candidate.textContent ?? '').trim().includes(${JSON.stringify(label)}));
    const id = label?.getAttribute('for');
    const field = (id ? document.getElementById(id) : label?.querySelector('input, textarea, select'))
      ?? [...document.querySelectorAll('input, textarea, select')]
        .find((candidate) => (candidate.getAttribute('placeholder') ?? '').includes(${JSON.stringify(label)}));
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    setter?.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  expect(changed, `Could not set ${label}`).toBe(true);
}

async function click(surface: Surface, label: string): Promise<void> {
  const clicked = await evalIn(surface, `(() => {
    const element = [...document.querySelectorAll('button, [role="button"], a[href]')]
      .find((candidate) => (candidate.textContent ?? '').trim().includes(${JSON.stringify(label)}));
    if (!(element instanceof HTMLElement) || element.getAttribute('aria-disabled') === 'true') return false;
    element.click();
    return true;
  })()`);
  expect(clicked, `Could not click ${label}`).toBe(true);
}

async function sendPrompt(desktop: Awaited<ReturnType<typeof app>>, prompt: string): Promise<void> {
  const createDeadline = Date.now() + 120_000;
  while (Date.now() < createDeadline) {
    await control(desktop, "session.create_task").catch(() => undefined);
    const created = await evalIn(desktop, `location.hash.includes('/session/ses_')`);
    if (created === true) break;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  await waitFor(desktop, `location.hash.includes('/session/ses_')`, {
    timeoutMs: 5_000,
    label: "chat-first task session created",
  });
  await waitUntilInteractive(desktop, { timeoutMs: 60_000 });
  await writeComposerText(desktop, prompt);
  const before = await readComposerState(desktop);
  await waitFor(
    desktop,
    `window.__openworkControl?.listActions?.()
      .some((action) => action.id === 'composer.send' && !action.disabled)`,
    { timeoutMs: 30_000, label: "chat-first session send enabled" },
  );
  await control(desktop, "composer.send");
  await waitFor(
    desktop,
    `document.querySelectorAll('[data-message-role="user"]').length > ${before.userMessageCount}`,
    { timeoutMs: 60_000, label: "prompt submitted" },
  );
  await waitForAssistantReply(desktop, { timeoutMs: 420_000 });
  await waitFor(
    desktop,
    `![...document.querySelectorAll('button')].some((button) => (button.textContent ?? '').trim() === 'Stop')`,
    { timeoutMs: 420_000, label: "Code Mode turn completed" },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let mcpRequestId = 0;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value).slice(0, 500)}`);
  return value;
}

async function agentRpc(
  apiUrl: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpRequestId, method, params }),
    signal: AbortSignal.timeout(180_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP ${method} failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`MCP ${method} returned no SSE data frame: ${raw.slice(0, 500)}`);
  const message = requireRecord(JSON.parse(dataLine.slice(5)), "MCP response");
  if (message.error) throw new Error(`MCP ${method} returned an error: ${JSON.stringify(message.error)}`);
  return requireRecord(message.result, `MCP ${method} result`);
}

test("a Code Mode result becomes a cloud Automation and a durable artifact result", { timeout: 1_500_000 }, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: { name: `Saved Script Automation ${Date.now()}`, admin: { name: "Sarah" } },
    mocks: { reports: mcpMock() },
  });
  const orgs = await denFetch(den.admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  const orgRows = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : [];
  const organizationId = String(orgRows[0]?.id ?? "");
  expect(organizationId).not.toBe("");

  const enabled = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ capabilities: { codemodeScripts: true } }),
  });
  expect(enabled.response.ok, enabled.text).toBe(true);

  const connection = await createOrgConnection(den.admin, {
    name: "Report source",
    url: den.mocks.reports.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  const catalog = await denFetch(den.admin, `/v1/mcp-connections/${connection.id}/tools`, {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  expect(catalog.response.ok, catalog.text).toBe(true);
  const catalogTools = isRecord(catalog.body) && Array.isArray(catalog.body.tools)
    ? catalog.body.tools.filter(isRecord)
    : [];
  const echoTool = catalogTools.find((tool) => tool.name === "mock_echo");
  const definitionDigest = typeof echoTool?.definitionDigest === "string" ? echoTool.definitionDigest : "";
  expect(definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  const approvedForCloud = await denFetch(den.admin, `/v1/mcp-connections/${connection.id}/tool-policy`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({
      allDisabled: false,
      disabledTools: [],
      unattendedApprovedTools: ["mock_echo"],
      unattendedApprovedToolDigests: { mock_echo: definitionDigest },
    }),
  });
  expect(approvedForCloud.response.ok, approvedForCloud.text).toBe(true);

  const stamp = Date.now();
  const scriptName = `Launch briefing ${stamp}`;
  const firstMarker = `launch-now-${stamp}`;
  const scheduledMarker = `launch-scheduled-${stamp}`;
  await using desktop = await app({
    den,
    as: "admin",
    place,
    ...(process.env.OPENWORK_EVAL_MODEL?.trim() ? { model: process.env.OPENWORK_EVAL_MODEL.trim() } : {}),
  });

  await sendPrompt(
    desktop,
    `Use search_capabilities to find the Report source echo capability, then call execute_capability_script exactly once. `
      + `The script must return { briefing: await tools.report_source.mock_echo({ text: input.topic }) } and input.topic must be ${firstMarker}. `
      + "Do not call execute_capability. Reply with the briefing after the tool succeeds.",
  );
  await waitForText(desktop, firstMarker, { timeoutMs: 60_000 });
  await waitForText(desktop, "Save as script", { timeoutMs: 60_000 });
  evidence.fact(
    "A successful ad-hoc Code Mode result is promotable without retyping its program",
    "The completed Code Mode card exposes Run again and Save as script actions.",
    true,
  );

  await click(desktop, "Save as script");
  await waitForText(desktop, "Save reusable script", { timeoutMs: 30_000 });
  await setField(desktop, "Name", scriptName);
  await setField(desktop, "Description", "Builds a reusable launch briefing from the connected report source.");
  await setField(desktop, "Input schema", JSON.stringify({
    type: "object",
    properties: { topic: { type: "string" } },
    required: ["topic"],
    additionalProperties: false,
  }));
  await setField(desktop, "Output schema", JSON.stringify({
    type: "object",
    properties: { briefing: {} },
    required: ["briefing"],
    additionalProperties: false,
  }));
  const saveReview = await visibleText(desktop);
  expect(saveReview).toContain("tools.report_source.mock_echo");
  expect(saveReview).toMatch(/read-only/i);
  const saveReviewShot = await screenshot(desktop);
  const saveReviewSeen = await validate(saveReviewShot, [
    "Save reusable script is presented as a right-side workbench while the current task remains visible",
    "The workbench shows script details and the Report source capability with a Read-only status",
    "Close, Cancel, and Save script actions are available without scrolling the workbench footer away",
  ]);
  expect(saveReviewSeen.ok, saveReviewSeen.why).toBe(true);
  await click(desktop, "Save script");
  await waitForText(desktop, "Script saved", { timeoutMs: 60_000 });

  await go(desktop, `/workspace/${desktop.workspaceId}/settings/extensions`);
  await waitForText(desktop, "Library", { timeoutMs: 60_000 });
  await waitFor(
    desktop,
    `[...document.querySelectorAll('input')]
      .some((field) => (field.getAttribute('placeholder') ?? '').includes('Search library'))`,
    { timeoutMs: 60_000, label: "Library search ready" },
  );
  await setField(desktop, "Search library", scriptName);
  await waitForText(desktop, scriptName, { timeoutMs: 30_000 });
  await waitForText(desktop, "Run now", { timeoutMs: 30_000 });
  const scriptDetail = await visibleText(desktop);
  expect(scriptDetail).toContain("Scripts");
  expect(scriptDetail).toContain("Validated output");
  expect(scriptDetail).toContain("Automate");

  await click(desktop, "Run now");
  await setField(desktop, "Input", JSON.stringify({ topic: firstMarker }));
  await click(desktop, "Run script");
  await waitFor(
    desktop,
    `document.body.innerText.toLowerCase().includes('validated result')
      || Boolean(document.querySelector('[role="dialog"] [role="alert"]'))`,
    { timeoutMs: 60_000, label: "manual Script result or error" },
  );
  const manualRunState = await evalIn(desktop, `(() => ({
    validated: document.body.innerText.toLowerCase().includes('validated result'),
    error: document.querySelector('[role="dialog"] [role="alert"]')?.textContent?.trim() ?? ''
  }))()`);
  expect(isRecord(manualRunState) && manualRunState.validated === true, `Manual Script run failed: ${isRecord(manualRunState) ? String(manualRunState.error) : "unknown"}`).toBe(true);
  await waitForText(desktop, firstMarker, { timeoutMs: 30_000 });
  await waitForText(desktop, "Receipt", { timeoutMs: 30_000 });
  const manualResultShot = await screenshot(desktop);
  const manualResultSeen = await validate(manualResultShot, [
    "A saved Script run shows a validated result",
    "The result contains the launch briefing marker",
    "The run UI offers a receipt and does not show an error",
  ]);
  expect(manualResultSeen.ok, manualResultSeen.why).toBe(true);
  evidence.fact(
    "The saved Script produces a validated artifact-ready result",
    "Run now shows a schema-valid result and a receipt without starting an agent session.",
    true,
  );
  await click(desktop, "Close");

  await click(desktop, "Automate");
  await waitForText(desktop, "Create Automation", { timeoutMs: 30_000 });
  const due = new Date(Date.now() + 2 * 60_000);
  const scheduledTime = `${String(due.getUTCHours()).padStart(2, "0")}:${String(due.getUTCMinutes()).padStart(2, "0")}`;
  await setField(desktop, "Name", `${scriptName} daily`);
  await setField(desktop, "Input", JSON.stringify({ topic: scheduledMarker }));
  await setField(desktop, "Schedule", "daily");
  await setField(desktop, "Time", scheduledTime);
  await setField(desktop, "Timezone", "UTC");
  const automationReview = await visibleText(desktop);
  expect(automationReview).toContain("OpenWork Cloud");
  expect(automationReview).toMatch(/exact script version/i);
  expect(automationReview).toMatch(/even when.*browser.*desktop.*closed/i);
  await click(desktop, "Create and activate");

  const calls = await den.mocks.reports.toolCalls({
    name: "mock_echo",
    atLeast: 2,
    timeoutMs: 5 * 60_000,
  });
  expect(calls.filter((call) => String(call.args.text ?? "").includes(scheduledMarker))).toHaveLength(1);
  await waitForText(desktop, "succeeded", { timeoutMs: 120_000 });
  await waitForText(desktop, scheduledMarker, { timeoutMs: 60_000 });
  const receipt = await visibleText(desktop);
  expect(receipt).toContain("OpenWork Cloud");
  expect(receipt).toMatch(/script version/i);
  expect(receipt).toMatch(/validated result/i);
  expect(receipt).not.toMatch(/execution thread/i);

  const shot = await screenshot(desktop);
  const seen = await validate(shot, [
    "A succeeded Automation run shows OpenWork Cloud as its execution location",
    "The run shows a saved Script version and a validated launch briefing result",
    "No desktop execution thread, model requirement, or error banner is visible",
  ]);
  expect(seen.ok, seen.why).toBe(true);

  const scriptsResponse = await denFetch(den.admin, "/v1/codemode-scripts", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  expect(scriptsResponse.response.ok, scriptsResponse.text).toBe(true);
  const scripts = isRecord(scriptsResponse.body) && Array.isArray(scriptsResponse.body.items)
    ? scriptsResponse.body.items.filter(isRecord)
    : [];
  const savedScript = scripts.find((candidate) => candidate.title === scriptName);
  const configObjectId = typeof savedScript?.configObjectId === "string" ? savedScript.configObjectId : "";
  expect(configObjectId).not.toBe("");

  const tokenResponse = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  expect(tokenResponse.response.ok, tokenResponse.text).toBe(true);
  const mcpToken = isRecord(tokenResponse.body) && typeof tokenResponse.body.token === "string"
    ? tokenResponse.body.token
    : "";
  expect(mcpToken).toMatch(/^ow_mcp_at_/);

  const toolList = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {});
  const tools = Array.isArray(toolList.tools) ? toolList.tools.filter(isRecord) : [];
  const renderTool = tools.find((candidate) => candidate.name === "render_dynamic_artifact");
  const renderToolMeta = isRecord(renderTool?._meta) ? renderTool._meta : {};
  const modernUi = isRecord(renderToolMeta.ui) ? renderToolMeta.ui : {};
  expect(modernUi.resourceUri).toBe("ui://openwork/dynamic-artifact/v1/view.html");
  expect(renderToolMeta["ui/resourceUri"]).toBe("ui://openwork/dynamic-artifact/v1/view.html");

  const resourceList = await agentRpc(den.ref.apiUrl, mcpToken, "resources/list", {});
  const resources = Array.isArray(resourceList.resources) ? resourceList.resources.filter(isRecord) : [];
  const appResource = resources.find((candidate) => candidate.uri === "ui://openwork/dynamic-artifact/v1/view.html");
  expect(appResource?.mimeType).toBe("text/html;profile=mcp-app");

  const resourceRead = await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", {
    uri: "ui://openwork/dynamic-artifact/v1/view.html",
  });
  const resourceContents = Array.isArray(resourceRead.contents) ? resourceRead.contents.filter(isRecord) : [];
  expect(resourceContents[0]?.mimeType).toBe("text/html;profile=mcp-app");
  expect(String(resourceContents[0]?.text ?? "")).toContain("ui/initialize");
  expect(String(resourceContents[0]?.text ?? "")).not.toContain("fetch(");

  const rendered = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "render_dynamic_artifact",
    arguments: { configObjectId },
  });
  expect(rendered.isError).not.toBe(true);
  const structured = requireRecord(rendered.structuredContent, "Dynamic Artifact structuredContent");
  const artifact = requireRecord(structured.artifact, "Dynamic Artifact lineage");
  const fallback = Array.isArray(rendered.content) ? rendered.content.filter(isRecord) : [];
  expect(structured.schemaVersion).toBe("1");
  expect(artifact.configObjectId).toBe(configObjectId);
  expect(artifact.source).toBe("scheduled");
  expect(String(artifact.receiptId ?? "")).not.toBe("");
  expect(JSON.stringify(structured.data)).toContain(scheduledMarker);
  expect(String(fallback[0]?.text ?? "")).toContain(scheduledMarker);
  evidence.fact(
    "The latest Automation snapshot is portable as a standards-based MCP App",
    "The agent endpoint links render_dynamic_artifact to a self-contained ui:// resource and returns the scheduled result as versioned structuredContent plus a Markdown fallback.",
    true,
  );

  const policyChangedAt = new Date().toISOString();
  const disabled = await denFetch(den.admin, `/v1/mcp-connections/${connection.id}/tool-policy`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ allDisabled: false, disabledTools: ["mock_echo"] }),
  });
  expect(disabled.response.ok, disabled.text).toBe(true);
  await click(desktop, "Run now");
  await waitForText(desktop, "Needs attention", { timeoutMs: 120_000 });
  const afterRevocation = await visibleText(desktop);
  expect(afterRevocation).toContain(scheduledMarker);
  expect(afterRevocation).toMatch(/last good Dynamic Artifact/i);
  let callsAfterRevocation = 0;
  try {
    callsAfterRevocation = (await den.mocks.reports.toolCalls({
      name: "mock_echo",
      atLeast: 1,
      sinceIso: policyChangedAt,
      timeoutMs: 5_000,
    })).length;
  } catch {
    callsAfterRevocation = 0;
  }
  expect(callsAfterRevocation).toBe(0);
  const revokedShot = await screenshot(desktop);
  const revokedSeen = await validate(revokedShot, [
    "The Automation run is visibly marked Needs attention after capability access was revoked",
    "The previous successful launch briefing remains visible as the last good Dynamic Artifact",
    "The screen does not claim that the failed run replaced the last good result",
  ]);
  expect(revokedSeen.ok, revokedSeen.why).toBe(true);
  evidence.fact(
    "Revoked capability access fails before provider I/O and preserves the last good result",
    `Provider calls after revocation: ${callsAfterRevocation}; the previous ${scheduledMarker} result remains visible.`,
    callsAfterRevocation === 0 && afterRevocation.includes(scheduledMarker),
  );
});
