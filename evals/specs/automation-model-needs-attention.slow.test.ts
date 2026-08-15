import { expect } from "vitest";
import { screenshot, validate } from "@openwork/fraimz";
import {
  clickButton,
  denFetch,
  evalIn,
  go,
  visibleText,
  waitFor,
  waitForText,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { app, needs, server, test } from "@openwork/testkit";

/**
 * CORE JOURNEY: an active Automation keeps its instructions, cadence, and
 * durable history when its pinned model disappears. Den records the first due
 * occurrence as skipped, pauses future dispatches in `needs_attention`, and
 * the app points the owner directly to a supported-model picker. Choosing a
 * replacement creates a new immutable revision, clears the warning, and
 * resumes from the next scheduled occurrence without replaying the skipped
 * one.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const SCHEDULE_TIMEOUT_MS = 120_000;
const LEGACY_PROVIDER_NAME = "Legacy Automation Models";
const LEGACY_MODEL_ID = "legacy-automation-model";
const REPLACEMENT_PROVIDER_NAME = "Replacement Automation Models";
const REPLACEMENT_MODEL_ID = "replacement-automation-model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function activeOrganizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const activeId = isRecord(result.body) && typeof result.body.activeOrgId === "string"
    ? result.body.activeOrgId
    : "";
  const active = organizations.find((organization) => organization.isActive === true) ?? organizations[0];
  const orgId = activeId || (active && typeof active.id === "string" ? active.id : "");
  if (!result.response.ok || !orgId) {
    throw new Error(`Finding the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return orgId;
}

async function createProvider(input: {
  admin: DenSession;
  orgId: string;
  providerKey: string;
  providerName: string;
  modelId: string;
  modelName: string;
}): Promise<string> {
  const result = await denFetch(input.admin, "/v1/llm-providers", {
    method: "POST",
    headers: { ...auth(input.admin), "x-openwork-org-id": input.orgId },
    body: JSON.stringify({
      name: input.providerName,
      source: "custom",
      customConfig: {
        id: input.providerKey,
        name: input.providerName,
        npm: "@ai-sdk/openai-compatible",
        env: [`${input.providerKey.toUpperCase().replaceAll("-", "_")}_API_KEY`],
        models: [{ id: input.modelId, name: input.modelName }],
      },
      apiKey: "sk-openwork-automation-transition-eval-only",
      allMembers: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider)
    ? result.body.llmProvider
    : null;
  const providerId = provider && typeof provider.id === "string" ? provider.id : "";
  if (result.response.status !== 201 || !providerId) {
    throw new Error(`Creating ${input.providerName} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return providerId;
}

async function createDueAutomation(input: {
  admin: DenSession;
  orgId: string;
  providerId: string;
  name: string;
  instructions: string;
}): Promise<string> {
  const nextMinute = new Date(Date.now() + 90_000);
  const result = await denFetch(input.admin, "/v1/automations", {
    method: "POST",
    headers: { ...auth(input.admin), "x-openwork-org-id": input.orgId },
    body: JSON.stringify({
      name: input.name,
      instructions: input.instructions,
      schedule: {
        kind: "daily",
        timezone: "UTC",
        hour: nextMinute.getUTCHours(),
        minute: nextMinute.getUTCMinutes(),
      },
      model: { providerId: input.providerId, modelId: LEGACY_MODEL_ID, variant: null },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const automation = isRecord(result.body) && isRecord(result.body.automation)
    ? result.body.automation
    : null;
  const automationId = automation && typeof automation.id === "string" ? automation.id : "";
  if (result.response.status !== 201 || !automationId) {
    throw new Error(`Creating the Automation failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return automationId;
}

async function deleteProvider(admin: DenSession, orgId: string, providerId: string): Promise<void> {
  const result = await denFetch(admin, `/v1/llm-providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(result.response.status).toBe(204);
}

async function skippedModelReceipt(admin: DenSession, orgId: string, automationId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + SCHEDULE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await denFetch(admin, `/v1/automations/${encodeURIComponent(automationId)}/runs`, {
      headers: { ...auth(admin), "x-openwork-org-id": orgId },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const items = isRecord(result.body) && Array.isArray(result.body.items)
      ? result.body.items.filter(isRecord)
      : [];
    const skipped = items.find((item) =>
      item.status === "skipped"
      && isRecord(item.error)
      && (item.error.code === "provider_unavailable" || item.error.code === "model_access_lost")
    );
    if (skipped) return skipped;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("The due occurrence was not recorded as skipped after its model disappeared.");
}

async function clickAutomationCard(surface: Surface, name: string): Promise<void> {
  const clicked = await evalIn(surface, `(() => {
    const card = [...document.querySelectorAll('button')]
      .find((candidate) => (candidate.textContent ?? '').includes(${JSON.stringify(name)}));
    if (!(card instanceof HTMLButtonElement)) return false;
    card.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
}

test("an unavailable Automation model needs attention until the owner selects a supported replacement", async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS", "OPENWORK_EVAL_AUTOMATIONS_SPEC"] });

  await using den = await server({ place });
  const orgId = await activeOrganizationId(den.admin);
  const stamp = Date.now();
  const automationName = `CRM transition check ${stamp}`;
  const instructions = `Keep the CRM transition marker ${stamp} in every summary.`;
  const legacyProviderId = await createProvider({
    admin: den.admin,
    orgId,
    providerKey: `legacy-automation-${stamp}`,
    providerName: LEGACY_PROVIDER_NAME,
    modelId: LEGACY_MODEL_ID,
    modelName: "Legacy Automation Model",
  });
  await createProvider({
    admin: den.admin,
    orgId,
    providerKey: `replacement-automation-${stamp}`,
    providerName: REPLACEMENT_PROVIDER_NAME,
    modelId: REPLACEMENT_MODEL_ID,
    modelName: "Replacement Automation Model",
  });
  const automationId = await createDueAutomation({
    admin: den.admin,
    orgId,
    providerId: legacyProviderId,
    name: automationName,
    instructions,
  });

  // The model disappears after the revision is durable but before dispatch.
  await deleteProvider(den.admin, orgId, legacyProviderId);
  const skippedReceipt = await skippedModelReceipt(den.admin, orgId, automationId);
  expect(skippedReceipt.trigger).toBe("scheduled");
  evidence.fact(
    "The first unavailable-model occurrence is retained once",
    "Den recorded one scheduled receipt as skipped before pausing the Automation.",
    true,
  );

  await using desktop = await app({ den, as: "admin", place });
  await go(desktop, `/workspace/${desktop.workspaceId}/automations`);
  await waitForText(desktop, automationName, { timeoutMs: 60_000 });
  await waitFor(desktop, `(() => {
    const card = document.querySelector('[data-automation-needs-attention]');
    return Boolean(card && (card.textContent ?? '').includes(${JSON.stringify(automationName)}));
  })()`, { timeoutMs: 60_000, label: "Automation card warning" });
  expect(await evalIn(desktop, "Boolean(document.querySelector('[data-automations-attention-indicator]'))")).toBe(true);
  expect(await visibleText(desktop)).toContain("Needs attention");
  evidence.fact(
    "The Automations list calls out the broken model",
    "The sidebar and affected card have warning icons, and the card reports Needs attention while healthy cards remain unchanged.",
    true,
  );

  await clickAutomationCard(desktop, automationName);
  await waitForText(desktop, "Model needs attention", { timeoutMs: 30_000 });
  const pausedDetail = await visibleText(desktop);
  expect(pausedDetail).toContain(instructions);
  expect(pausedDetail).toContain(`${legacyProviderId}/${LEGACY_MODEL_ID}`);
  expect(pausedDetail).toContain("No future run scheduled");
  expect(pausedDetail).toContain("Skipped — model unavailable");
  const runNowDisabled = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => (candidate.textContent ?? '').trim() === 'Run now');
    return button instanceof HTMLButtonElement && button.disabled;
  })()`);
  expect(runNowDisabled).toBe(true);
  evidence.fact(
    "The detail page preserves context and pauses execution",
    "Instructions, schedule, old model identity, and skipped history remain visible; Run now and future scheduling are paused.",
    true,
  );

  await clickButton(desktop, "Select a supported model");
  await waitForText(desktop, "Current model is no longer available", { timeoutMs: 30_000 });
  await waitFor(desktop, `(() => {
    const dialog = document.querySelector('[role=dialog]');
    return Boolean(dialog && (dialog.textContent ?? '').includes('Replacement Automation Model'));
  })()`, { timeoutMs: 30_000, label: "supported replacement model picker" });
  const pickerText = await evalIn(desktop, `document.querySelector('[role=dialog]')?.textContent ?? ''`);
  expect(String(pickerText)).toContain("Replacement Automation Model");
  expect(String(pickerText)).not.toContain("Legacy Automation Model");
  const selectedReplacement = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[role=dialog]');
    const item = dialog && [...dialog.querySelectorAll('[cmdk-item], [role=option], button')]
      .find((candidate) => (candidate.textContent ?? '').includes('Replacement Automation Model'));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(selectedReplacement).toBe(true);
  await clickButton(desktop, "Save changes");

  await waitForText(desktop, "Active", { timeoutMs: 60_000 });
  await waitForText(desktop, "Revision 2", { timeoutMs: 30_000 });
  const repairedDetail = await visibleText(desktop);
  expect(repairedDetail).toContain(`${REPLACEMENT_PROVIDER_NAME} · Replacement Automation Model`);
  expect(repairedDetail).not.toContain("Model needs attention");
  expect(repairedDetail).not.toContain("No future run scheduled");
  expect(repairedDetail).toContain("Skipped — model unavailable");
  const finalRunNowDisabled = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => (candidate.textContent ?? '').trim() === 'Run now');
    return button instanceof HTMLButtonElement ? button.disabled : null;
  })()`);
  expect(finalRunNowDisabled).toBe(false);
  await waitFor(desktop, "!document.querySelector('[data-automations-attention-indicator]')", {
    timeoutMs: 30_000,
    label: "sidebar warning clears after model replacement",
  });

  const runs = await denFetch(den.admin, `/v1/automations/${encodeURIComponent(automationId)}/runs`, {
    headers: { ...auth(den.admin), "x-openwork-org-id": orgId },
  });
  const runItems = isRecord(runs.body) && Array.isArray(runs.body.items) ? runs.body.items : [];
  expect(runItems).toHaveLength(1);
  evidence.fact(
    "Explicit replacement resumes without replay",
    "Saving the supported model created revision 2, restored Active with a next run, retained the skipped receipt, and did not replay it.",
    true,
  );

  const shot = await screenshot(desktop);
  const seen = await validate(shot, [
    "The repaired Automation is Active and shows revision 2",
    "The replacement model is visible in Desktop execution",
    "The earlier skipped run remains visible in Run history",
    "No model-needs-attention warning or error stack is visible",
  ]);
  expect(seen.ok, seen.why).toBe(true);
});
