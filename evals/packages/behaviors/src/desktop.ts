import { describeAppState, evaluateOnSurface, isInteractive, probeAppState } from "@openwork/cdp";
import type { AppStateProbe, EvaluateOptions, Surface } from "@openwork/cdp";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DEFAULT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsValue(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Cannot interpolate an undefined JavaScript value.");
  return json.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export async function evalIn(app: Surface, expression: string, opts: EvaluateOptions = {}): Promise<unknown> {
  // Target healing lives in @openwork/cdp; behaviours just evaluate.
  return evaluateOnSurface(app, expression, opts);
}

/**
 * Read something from the page, tolerating a renderer that is briefly blocked.
 * The app blocks its JS thread while a workspace runtime boots, so a single
 * evaluation can be caught mid-block; retrying short calls is reliable where one
 * long call is not. Only for IDEMPOTENT reads — never for clicks.
 */
async function resilientRead(
  app: Surface,
  expression: string,
  { timeoutMs = 240_000, perAttemptMs = 10_000, label = expression }: { timeoutMs?: number; perAttemptMs?: number; label?: string } = {},
): Promise<unknown> {
  // A cold profile can block its JS thread for minutes while the workspace
  // runtime boots, so retry to a deadline rather than a fixed attempt count.
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      return await evalIn(app, expression, { timeoutMs: perAttemptMs });
    } catch (error) {
      lastError = error;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`Could not read ${label} within ${timeoutMs}ms (${attempts} attempts)${lastError ? `: ${messageText(lastError)}` : ""}.`);
}

export async function waitFor(
  app: Surface,
  expression: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS, label = expression, awaitPromise = false }: { timeoutMs?: number; label?: string; awaitPromise?: boolean } = {},
): Promise<unknown> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  // Each probe gets a SHORT timeout on purpose: a renderer that is briefly busy
  // should have the call abandoned and retried on the next tick. Giving a probe
  // the whole budget turns one stuck evaluation into the entire wait.
  const evalTimeoutMs = Math.min(timeoutMs, 15_000);
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await evalIn(app, expression, { timeoutMs: evalTimeoutMs, awaitPromise });
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last error: ${messageText(lastError)})` : ""}.`);
}

export async function waitForText(app: Surface, text: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await waitFor(app, `document.body.innerText.includes(${jsValue(text)})`, {
    timeoutMs: opts.timeoutMs,
    label: `visible text ${jsValue(text)}`,
  });
}

export async function hasText(app: Surface, text: string): Promise<boolean> {
  return Boolean(await resilientRead(app, `document.body.innerText.includes(${jsValue(text)})`, { label: `text ${jsValue(text)}` }));
}

export async function visibleText(app: Surface): Promise<string> {
  const text = await resilientRead(app, "document.body.innerText", { label: "visible text" });
  if (typeof text !== "string") throw new Error("CDP did not return document.body.innerText as a string.");
  return text;
}

export async function clickText(
  app: Surface,
  text: string,
  { selector = "button, [role=button], a", timeoutMs = DEFAULT_TIMEOUT_MS }: { selector?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  return waitFor(app, `(() => {
    const candidates = document.querySelectorAll(${jsValue(selector)});
    for (const element of candidates) {
      const label = (element.textContent ?? '').trim();
      if (label.includes(${jsValue(text)})) {
        element.scrollIntoView({ block: 'center' });
        element.click();
        return label;
      }
    }
    return null;
  })()`, { timeoutMs, label: `clickable element with text ${jsValue(text)}` });
}

export async function clickButton(app: Surface, label: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  await waitFor(app, `Boolean([...document.querySelectorAll('button')]
    .find((element) => (element.textContent ?? '').trim() === ${jsValue(label)} && !element.disabled))`, {
    timeoutMs,
    label: `enabled button: ${label}`,
  });
  const clicked = await evalIn(app, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => (element.textContent ?? '').trim() === ${jsValue(label)} && !element.disabled);
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`);
  if (clicked !== true) throw new Error(`Could not click ${label}.`);
}

export async function waitForButtonGone(app: Surface, label: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await waitFor(app, `!Boolean([...document.querySelectorAll('button')]
    .find((element) => (element.textContent ?? '').trim() === ${jsValue(label)}))`, {
    timeoutMs: opts.timeoutMs ?? 90_000,
    label: `button removed: ${label}`,
  });
}

export async function fill(app: Surface, selector: string, value: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await waitFor(app, `Boolean(document.querySelector(${jsValue(selector)}))`, {
    timeoutMs: opts.timeoutMs,
    label: `input ${selector}`,
  });
  await evalIn(app, `(() => {
    const input = document.querySelector(${jsValue(selector)});
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, ${jsValue(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

export async function go(app: Surface, hashPath: string): Promise<void> {
  const hash = hashPath.startsWith("#") ? hashPath : `#${hashPath}`;
  // Setting the hash is idempotent, so retry through renderer freeze bursts
  // rather than letting one blocked evaluate fail a whole spec. Contention (two
  // desktops on one host) makes those bursts routine, and a bare 20s evaluate
  // here was the single most common way a long journey died near its end.
  // 120s: with several desktops and their engines on one host the renderer can
  // stay blocked well past a minute. Retrying an idempotent hash assignment
  // costs nothing when the app is healthy.
  await waitFor(app, `(() => { window.location.hash = ${jsValue(hash)}; return true; })()`, {
    timeoutMs: 120_000,
    label: `navigate to ${hash}`,
  });
}

export async function currentHash(app: Surface): Promise<string> {
  const hash = await resilientRead(app, "window.location.hash", { label: "location hash" });
  if (typeof hash !== "string") throw new Error("CDP did not return window.location.hash as a string.");
  return hash;
}

export async function enabledButtons(app: Surface): Promise<string[]> {
  const labels = await resilientRead(app, `[...document.querySelectorAll('button')]
    .filter((element) => !element.disabled)
    .map((element) => (element.textContent ?? '').trim())
    .filter(Boolean)`, { label: "enabled buttons" });
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
    throw new Error("CDP did not return enabled button labels as strings.");
  }
  return labels;
}

/** Invoke a registered `window.__openworkControl` action, the product's own automation seam. */
export async function control(
  app: Surface,
  action: string,
  args?: unknown,
  opts: EvaluateOptions = {},
): Promise<unknown> {
  const result = await evalIn(
    app,
    `window.__openworkControl.execute(${JSON.stringify(action)}, ${JSON.stringify(args ?? null)})`,
    { ...opts, awaitPromise: true },
  );
  if (!isRecord(result) || result.ok !== true) {
    throw new Error(`Desktop control action ${action} failed: ${isRecord(result) ? String(result.error ?? "unknown") : "unknown"}`);
  }
  return result.result;
}

/**
 * Wait until the app is interactive again — the same predicate the lifecycle
 * layer applies when handing out a desktop handle. Use it after any action that
 * navigates or creates a workspace/session, so assertions and frames never race
 * the app's loading placeholders.
 */
export async function waitUntilInteractive(
  app: Surface,
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
): Promise<AppStateProbe> {
  const deadline = Date.now() + timeoutMs;
  let last: AppStateProbe = { controlReady: false, transitional: null, surface: null, workspaceId: null, route: "", text: "" };
  while (Date.now() < deadline) {
    try {
      last = await probeAppState(app.client, { timeoutMs: 15_000 });
      if (isInteractive(last)) return last;
    } catch {
      // A navigation can destroy the execution context mid-probe.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`App did not become interactive after ${timeoutMs}ms: ${describeAppState(last)}`);
}

/** Wait until the page's visible text stops changing — the app is done working. */
export async function waitUntilTextStable(
  app: Surface,
  { quietMs = 6_000, timeoutMs = 240_000 }: { quietMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const current = await visibleText(app).catch(() => previous);
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return current;
    }
    await sleep(1_000);
  }
  return previous;
}
