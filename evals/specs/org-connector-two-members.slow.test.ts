import { expect, onTestFinished, test } from "vitest";
import { photoRoll, screenshot, validate } from "@openwork/fraimz";
import { daytonaSandbox, desktop } from "@openwork/hosts";
import { startMockMcp } from "@openwork/labs";
import {
  clickButton,
  createAndSelectWorkspace,
  createOrgConnection,
  deleteConnection,
  deleteConnectionsNamed,
  ensureMemberSession,
  evalIn,
  go,
  readAvailableModels,
  readUsableConnection,
  selectModel,
  signIn,
  signInDesktopAs,
  waitFor,
  waitForText,
  writeComposerText,
} from "@openwork/behaviors";
import type { DesktopHandle, Host } from "@openwork/hosts";
import type { DenRef, DenSession } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";

/**
 * CORE JOURNEY: an admin publishes one organization MCP connector; two different
 * people each connect their OWN account and then actually use its tools from the
 * composer. Neither inherits the other's credential.
 *
 * Faithfulness notes:
 *  - Two SEPARATE desktops, each with its own isolated profile, signed in as
 *    different members. A single desktop clearing localStorage only simulates
 *    per-member isolation; two desktops make it real.
 *  - The connector itself is the authority on "was it used": we assert on the
 *    tool calls it actually served, and on DISTINCT bearer-token fingerprints,
 *    rather than trusting the app's own "Connected" text.
 *  - The tool call is a real agent task through the product's composer.
 *
 * PLACEMENT: set OPENWORK_EVAL_DAYTONA_SANDBOX_A and _B to put each member's
 * desktop on its own Daytona sandbox (the driver must run outside any sandbox).
 * That is the reliable shape: two desktops plus two engines starve renderers on
 * one 9GB sandbox. Without A/B both desktops share the ambient host.
 *
 * When the desktops are remote, the mock connector cannot live on the driver's
 * loopback: Den dials it server-side (discovery, DCR, token, tool calls), each
 * desktop's browser opens its /authorize, and the driver polls /requests. Host
 * it somewhere all three can reach and point
 * OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL at it (ISSUER must be that same URL).
 */

const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
/**
 * OPT-IN because it needs provisioned placement, not because anything is broken.
 * (An earlier revision blamed a product defect for a blank connections surface;
 * that was this spec racing the app's route rewrite and the panel's first paint,
 * both fixed here and in org-connection-lifecycle. Retracted.)
 *
 * The tool-call phase runs two desktops and two engines at once — more than one
 * eval sandbox reliably gives. Run it with OPENWORK_EVAL_DAYTONA_SANDBOX_A/_B
 * placing each desktop on its own sandbox, a Den both can reach, and the mock
 * published at OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL.
 */
const optedIn = process.env.OPENWORK_EVAL_CONNECTOR_SPEC === "1";
const sandboxA = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX_A?.trim() ?? "";
const sandboxB = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX_B?.trim() ?? "";
const title = !appSpecsEnabled
  ? "org connector two members skipped: set OPENWORK_EVAL_APP_SPECS=1 to opt in"
  : !apiUrl
    ? "org connector two members skipped: set OPENWORK_EVAL_DEN_API_URL to a running Den"
    : !optedIn
      ? "org connector two members skipped: needs two desktops plus two engines (see header); set OPENWORK_EVAL_CONNECTOR_SPEC=1 and place them with OPENWORK_EVAL_DAYTONA_SANDBOX_A/_B"
      : "two members each connect their own account to one org connector and call its tools";

const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const adminEmail = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const aEmail = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const bEmail = process.env.OPENWORK_EVAL_MEMBER_B_EMAIL?.trim() || "riley.demo@acme.test";
// Zen's free default is not promised to be reliable at tool calls; OPENAI_API_KEY
// is on the eval secrets volume, so a tool-capable model is available when set.
const modelId = process.env.OPENWORK_EVAL_MODEL?.trim() || "";

async function waitForConnectionCard(app: Surface, name: string, workspaceId: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // Short per-probe timeout, failure tolerated: two desktops in one sandbox
    // make the renderer freeze in bursts, and a bare 20s evaluate turns one
    // freeze into a failed spec.
    const found = await evalIn(app, `([...document.querySelectorAll('button')]
      .some((button) => (button.textContent ?? '').includes(${JSON.stringify(name)})))`, { timeoutMs: 8_000 })
      .catch(() => false);
    if (found === true) return;
    // The app opens a freshly created session on its own, which navigates away
    // from settings mid-poll. Steer back, the way a person would click back.
    // The app CANONICALISES this route: /settings/extensions/connections
    // becomes /extensions/connections. Checking for the pre-rewrite form made
    // the steer-back below fire every iteration, so navigation fought the
    // rewrite and the surface never settled — which looked like a blank page.
    const onExtensions = await evalIn(app, `window.location.hash.includes("/extensions")`, { timeoutMs: 8_000 }).catch(() => false);
    if (onExtensions !== true) {
      await go(app, `/workspace/${workspaceId}/settings/extensions/connections`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      continue;
    }
    await evalIn(app, "window.__openworkControl.execute('extensions.refresh-marketplace', null)", { awaitPromise: true, timeoutMs: 15_000 })
      .catch(() => undefined);
    await evalIn(app, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((element) => (element.textContent ?? '').trim() === 'Refresh' && !element.disabled);
      button?.click();
      return Boolean(button);
    })()`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  // Say what WAS on screen: "card missing" alone cannot distinguish an
  // unmounted surface from a connection den never offered this member.
  const seen = await evalIn(app, `({
    hash: window.location.hash,
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 40),
    text: (document.body.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 600),
  })`).catch(() => null);
  throw new Error(`The connection card ${name} never appeared. On screen: ${JSON.stringify(seen)}`);
}

/**
 * Wait for text to be REALLY on screen, then bring it into view.
 *
 * waitForText proves the DOM contains it; a frame proves pixels. The detail
 * panel paints slightly after its text lands, so screenshotting on the DOM
 * signal alone captures a blank panel intermittently.
 */
async function revealText(app: Surface, text: string, timeoutMs = 45_000): Promise<void> {
  await waitFor(app, `(() => {
    // innerText, not textContent: innerText is render-aware, so CSS
    // text-transform (a badge styled uppercase) matches what waitForText saw
    // and what a person reads. Comparing raw textContent can never agree.
    const wanted = ${JSON.stringify(text)}.toLowerCase();
    const nodes = [...document.querySelectorAll("button, h1, h2, h3, p, span, div")];
    const node = nodes.reverse().find((element) => ((element.innerText ?? element.textContent ?? "")).toLowerCase().includes(wanted));
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    node.scrollIntoView({ block: "center" });
    return true;
  })()`, { timeoutMs, label: `visible text ${JSON.stringify(text)}` });
  // One paint after scrolling, so the frame is not captured mid-scroll.
  await new Promise((resolve) => setTimeout(resolve, 750));
}

/** The connections surface, settled — polling before it mounts finds nothing. */
async function openConnectionsSurface(app: Surface, workspaceId: string): Promise<void> {
  await go(app, `/workspace/${workspaceId}/settings/extensions/connections`);
  await waitFor(app, `window.location.hash.includes("/extensions") && document.body.innerText.includes("Extensions")`, {
    timeoutMs: 60_000,
    label: "extensions connections route (app canonicalises away /settings)",
  });
}

async function openConnectionDetail(app: Surface, name: string): Promise<void> {
  await waitFor(app, `(() => {
    const card = [...document.querySelectorAll('button')]
      .find((button) => (button.textContent ?? '').includes(${JSON.stringify(name)}));
    if (!card) return false;
    card.click();
    return true;
  })()`, { timeoutMs: 30_000, label: `opened connection detail ${name}` });
}

/** Bring one member's desktop to the org connections surface, signed in as them. */
async function memberDesktop(name: string, den: DenRef, member: DenSession, host?: Host): Promise<{ app: DesktopHandle; workspaceId: string }> {
  const app = await desktop({
    name,
    host,
    bootstrap: { baseUrl: den.webUrl, apiBaseUrl: den.webUrl, requireSignin: false },
  });
  // Workspace first, then the org sign-in: the signed-in org shell offers no
  // Add workspace entry, so a member's workspace exists before they connect.
  const path = `/tmp/openwork-${name}-${Date.now()}`;
  await createAndSelectWorkspace(app, { path });
  await signInDesktopAs(app, den, member);
  const { workspaceId } = await createAndSelectWorkspace(app, { path });
  return { app, workspaceId };
}

test.skipIf(!appSpecsEnabled || !apiUrl || !optedIn)(title, async () => {
  const den: DenRef = {
    apiUrl,
    webUrl: (process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim() || apiUrl.replace("127.0.0.1", "localhost")).replace(/\/+$/, ""),
  };
  await using roll = photoRoll("org-connector-two-members");
  // Half-specified placement would silently recreate the one-sandbox squeeze.
  if (Boolean(sandboxA) !== Boolean(sandboxB)) {
    throw new Error("Set both OPENWORK_EVAL_DAYTONA_SANDBOX_A and _B (or neither).");
  }
  if (sandboxA) expect(sandboxA).not.toBe(sandboxB);

  // ── The connector we own, with OAuth per member ──────────────────────
  await using conn = await startMockMcp({
    port: Number(process.env.OPENWORK_EVAL_CONNECTOR_MOCK_PORT ?? 3979),
    publicUrl: process.env.OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL?.trim() || undefined,
  });
  const admin = await signIn(den, { email: adminEmail, password });
  const memberA = await ensureMemberSession(den, admin, {
    email: aEmail,
    password,
    name: "Jordan Demo",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  const memberB = await ensureMemberSession(den, admin, {
    email: bEmail,
    password,
    name: "Riley Demo",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });

  await deleteConnectionsNamed(admin, "Acme Tickets ");
  const connection = await createOrgConnection(admin, {
    name: `Acme Tickets ${Date.now()}`,
    url: conn.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  onTestFinished(async () => deleteConnection(admin, connection.id));

  // Published, but nobody has connected their own account yet.
  expect((await readUsableConnection(memberA, connection.id))?.connectedForMe).toBe(false);
  expect((await readUsableConnection(memberB, connection.id))?.connectedForMe).toBe(false);

  // ── Member A connects their own account ──────────────────────────────
  const a = await memberDesktop("connector-member-a", den, memberA, sandboxA ? daytonaSandbox(sandboxA) : undefined);
  await using appA = a.app;
  if (sandboxA) expect(appA.handle.sandboxId).toBe(sandboxA);
  await openConnectionsSurface(appA, a.workspaceId);
  await waitForConnectionCard(appA, connection.name, a.workspaceId);
  await waitForText(appA, "NEEDS YOUR SIGN-IN", { timeoutMs: 60_000 });
  await openConnectionDetail(appA, connection.name);
  await waitForText(appA, "OAuth required", { timeoutMs: 30_000 });
  await revealText(appA, "Connect your account");
  {
    const shot = await screenshot(appA);
    const seen = await validate(shot, [
      "An organization connection detail is visible saying the person must connect their own account",
      "No 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  const aClickedAt = new Date().toISOString();
  await clickButton(appA, "Connect your account");
  await conn.authorizeRequestSince(aClickedAt);
  await waitForText(appA, "Connected with your own account.", { timeoutMs: 120_000 });
  await expect.poll(
    async () => (await readUsableConnection(memberA, connection.id))?.connectedForMe,
    { timeout: 90_000, interval: 1_000 },
  ).toBe(true);
  await revealText(appA, "Connected with your own account.");
  {
    const shot = await screenshot(appA);
    const seen = await validate(shot, [
      "The connection detail visibly says the person is connected with their own account",
      "No Connect your account action or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  // ── THE ISOLATION ASSERTION — why two desktops exist ─────────────────
  const b = await memberDesktop("connector-member-b", den, memberB, sandboxB ? daytonaSandbox(sandboxB) : undefined);
  await using appB = b.app;
  if (sandboxB) expect(appB.handle.sandboxId).toBe(sandboxB);
  await openConnectionsSurface(appB, b.workspaceId);
  await waitForConnectionCard(appB, connection.name, b.workspaceId);
  // A is connected. B must NOT have inherited A's credential.
  await waitForText(appB, "NEEDS YOUR SIGN-IN", { timeoutMs: 60_000 });
  expect((await readUsableConnection(memberB, connection.id))?.connectedForMe).toBe(false);
  expect((await readUsableConnection(memberA, connection.id))?.connectedForMe).toBe(true);
  await revealText(appB, "NEEDS YOUR SIGN-IN");
  {
    const shot = await screenshot(appB);
    const seen = await validate(shot, [
      "A second person's app still shows the organization connection needing their own sign-in",
      "No 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }

  const bClickedAt = new Date().toISOString();
  await openConnectionDetail(appB, connection.name);
  await clickButton(appB, "Connect your account");
  await conn.authorizeRequestSince(bClickedAt);
  await waitForText(appB, "Connected with your own account.", { timeoutMs: 120_000 });
  await expect.poll(
    async () => (await readUsableConnection(memberB, connection.id))?.connectedForMe,
    { timeout: 90_000, interval: 1_000 },
  ).toBe(true);

  // ── Both people actually USE it: real tool calls from the composer ───
  // The mock can be long-lived (publicUrl): only calls it serves from here on
  // are this run's. Same driver-clock-vs-mock-clock contract as
  // authorizeRequestSince, which already held for both connects above.
  const submittedSince = new Date().toISOString();
  const markers: Record<string, string> = {};
  for (const [label, entry] of [["a", a], ["b", b]] as const) {
    const { app, workspaceId } = entry;
    const marker = `${label}-${Date.now()}`;
    markers[label] = marker;

    await go(app, `/workspace/${workspaceId}/session`);
    if (modelId) {
      const models = await readAvailableModels(app);
      expect(
        models.some((model) => model.id === modelId && model.selectable),
        `${modelId} is not selectable under this org's desktop policy. Saw: ${models.map((m) => m.id).join(", ")}`,
      ).toBe(true);
      await selectModel(app, modelId);
    }
    await writeComposerText(app, `Call the mock_echo tool with text exactly "${marker}" and reply with only its result.`);
    await clickButton(app, "Run task");
  }

  // The connector is the witness: two calls, two DISTINCT credentials.
  const calls = await conn.toolCalls({ name: "mock_echo", atLeast: 2, timeoutMs: 240_000, sinceIso: submittedSince });
  expect(
    calls.length,
    `expected both members to invoke mock_echo. Saw: ${JSON.stringify(calls)}`,
  ).toBeGreaterThanOrEqual(2);
  const texts = calls.map((call) => String(call.args.text ?? ""));
  expect(texts.some((text) => text.includes(markers.a ?? "\u0000"))).toBe(true);
  expect(texts.some((text) => text.includes(markers.b ?? "\u0000"))).toBe(true);
  // Per-member credentials: the two calls cannot share one bearer token.
  const tokenIds = new Set(calls.map((call) => call.tokenId).filter((id): id is string => Boolean(id)));
  expect(
    tokenIds.size,
    `both members' tool calls used the same credential — per-member isolation is broken. Calls: ${JSON.stringify(calls)}`,
  ).toBeGreaterThanOrEqual(2);
  {
    const shot = await screenshot(appB);
    const seen = await validate(shot, [
      "An OpenWork session surface is visible with a task that used the connected organization tool",
      "No 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await roll.add(shot, seen);
  }
});
