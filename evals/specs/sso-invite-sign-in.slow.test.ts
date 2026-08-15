import { expect } from "vitest";
import { localMysqlIsRunning, server, test } from "@openwork/testkit";
import { denFetch, evalIn, provisionOrg, waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { screenshot } from "@openwork/fraimz";
import { chrome } from "@openwork/hosts";
import { startMockIdpLab } from "@openwork/labs";

const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !localPlacement
  ? "SSO invite sign-in skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
  : !mysqlOpen
    ? "SSO invite sign-in skipped — needs MySQL on 127.0.0.1:3306"
    : "an invited person whose company uses SSO is sent to their identity provider, not asked for a password";

function readStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const record: Record<string, unknown> = { ...value };
  const found = record[key];
  return typeof found === "string" ? found : "";
}

function readBooleanField(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record: Record<string, unknown> = { ...value };
  return record[key] === true;
}

/**
 * The invite screen resolves how to sign someone in by asking Den about their
 * email, and SSO is the branch where getting it wrong is worst: an enterprise
 * that federates identity usually forbids passwords outright, so offering a
 * password field is not a cosmetic slip but a dead end for the whole company.
 *
 * That resolution is also the lookup whose result used to be discarded, leaving
 * the screen checking the sign-in method forever. This spec covers the SSO half
 * of that fix, and follows through to the identity provider and back, because
 * arriving at the provider is worthless if the invitation is lost on the way.
 */
test.skipIf(!localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  const stamp = Date.now();
  const ssoDomain = "sso-acme.test";
  const invitee = `sso-newcomer-${stamp}@${ssoDomain}`;

  // A loopback issuer is what marks the domain verified in dev mode, which is
  // the condition Den requires before it will route a domain to SSO at all. It
  // has to come up first so Den can be told to trust the origin it lands on.
  await using idp = await startMockIdpLab({
    domain: ssoDomain,
    defaultSubject: { email: invitee, name: "SSO Newcomer" },
  });
  await using den = await server({ place, trustedOrigins: [new URL(idp.issuer).origin] });

  const org = await provisionOrg(den.ref, { members: [] });
  // Registering a provider runs through Better-Auth, which wants a session
  // cookie rather than the bearer token the rest of the org API accepts.
  const signedIn = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: org.admin.email, password: org.admin.password }),
  });
  const sessionCookie = signedIn.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
  expect(sessionCookie, `sign in as the owner: HTTP ${signedIn.response.status} ${signedIn.text.slice(0, 300)}`).toBeTruthy();

  const registration = idp.registration();
  const registered = await denFetch(den.ref, "/v1/sso/oidc", {
    method: "POST",
    headers: {
      authorization: `Bearer ${org.admin.token}`,
      cookie: sessionCookie,
      "x-openwork-org-id": org.orgId,
    },
    body: JSON.stringify({
      issuer: registration.issuer,
      domain: registration.domain,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      scopes: registration.scopes,
      skipDiscovery: registration.skipDiscovery,
      authorizationEndpoint: registration.authorizationEndpoint,
      tokenEndpoint: registration.tokenEndpoint,
      jwksEndpoint: registration.jwksEndpoint,
      userInfoEndpoint: registration.userInfoEndpoint,
      tokenEndpointAuthentication: registration.tokenEndpointAuthentication,
    }),
  });
  expect(registered.response.ok, `register SSO: HTTP ${registered.response.status} ${registered.text.slice(0, 300)}`).toBe(true);

  const invited = await denFetch(den.ref, "/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${org.admin.token}` },
    body: JSON.stringify({ email: invitee, role: "member" }),
  });
  const inviteToken = readStringField(invited.body, "inviteToken");
  expect(inviteToken, `invite: HTTP ${invited.response.status} ${invited.text.slice(0, 300)}`).toBeTruthy();

  // Den's Better-Auth base URL is on localhost, and localhost and 127.0.0.1 do
  // not share cookies, so the browser has to stay on localhost for the whole
  // round trip or the state cookie written on the way out is gone on the way
  // back and the callback fails with state_mismatch.
  const webOrigin = den.ref.webUrl.replace("127.0.0.1", "localhost");
  await using browser = await chrome({
    name: "sso-invite",
    startUrl: webOrigin,
    headless: true,
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await navigate(browser.client, `${webOrigin}/join-org?invite=${encodeURIComponent(inviteToken)}`);
  await waitFor(browser, `/sign in with sso/i.test(document.body?.innerText ?? "")`, {
    timeoutMs: 90_000,
    label: "SSO step on the invite screen",
  });
  await screenshot(browser);

  const inviteScreen: unknown = JSON.parse(String(await evalIn(browser, `(() => {
    const scope = document.querySelector('[data-testid="join-org-auth"]');
    const text = document.body.innerText;
    return JSON.stringify({
      offersSso: /sign in with sso/i.test(text),
      saysTheOrganizationManagesIt: /managed by your organization/i.test(text),
      showsTheInvitedEmail: text.includes(${JSON.stringify(invitee)}),
      asksForAPassword: Boolean(scope?.querySelector('input[type="password"]')),
      stillCheckingSignInMethod: /checking the workspace sign-in method/i.test(text),
      text: text.replace(/\\s+/g, " ").slice(0, 240),
    });
  })()`)));
  expect(readBooleanField(inviteScreen, "offersSso")).toBe(true);
  expect(readBooleanField(inviteScreen, "saysTheOrganizationManagesIt")).toBe(true);
  expect(readBooleanField(inviteScreen, "showsTheInvitedEmail")).toBe(true);
  expect(readBooleanField(inviteScreen, "asksForAPassword")).toBe(false);
  expect(readBooleanField(inviteScreen, "stillCheckingSignInMethod")).toBe(false);
  evidence.fact(
    "An invited person governed by SSO is offered their identity provider, never a password",
    `The invite screen rendered: ${readStringField(inviteScreen, "text")}`,
    true,
  );

  // Reaching the provider only counts if the invitation survives the trip, so
  // read the link the button actually points at before following it.
  const ssoTarget = String(await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => /sign in with sso/i.test(candidate.textContent ?? ""));
    if (!button) return "";
    button.click();
    return "clicked";
  })()`));
  expect(ssoTarget).toBe("clicked");

  await waitFor(browser, `/one click away|you're in|welcome to/i.test(document.body?.innerText ?? "")`, {
    timeoutMs: 120_000,
    label: "back from the identity provider",
  });
  await screenshot(browser);

  const afterSso: unknown = JSON.parse(String(await evalIn(browser, `(() => {
    const text = document.body.innerText;
    return JSON.stringify({
      landedPath: window.location.pathname,
      cameBackToTheInvitation: /one click away|you're in|welcome to/i.test(text),
      signedInAsTheInvitedPerson: (text.match(/ACCOUNT\\s+(\\S+@\\S+)/) ?? [])[1] === ${JSON.stringify(invitee)},
      neverAskedForAPassword: !document.querySelector('input[type="password"]'),
      text: text.replace(/\\s+/g, " ").slice(0, 240),
    });
  })()`)));
  expect(readBooleanField(afterSso, "cameBackToTheInvitation")).toBe(true);
  expect(readBooleanField(afterSso, "signedInAsTheInvitedPerson")).toBe(true);
  expect(readBooleanField(afterSso, "neverAskedForAPassword")).toBe(true);
  expect(readStringField(afterSso, "landedPath")).toBe("/join-org");
  evidence.fact(
    "The invitation survives the round trip to the identity provider",
    `The identity provider signed them in and returned them to ${readStringField(afterSso, "landedPath")}, still holding the invitation and now on the invited account: ${readStringField(afterSso, "text")}`,
    true,
  );

  const joinClicked = String(await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => /^join /i.test((candidate.textContent ?? "").trim()));
    if (!button) return "";
    button.click();
    return "clicked";
  })()`));
  expect(joinClicked).toBe("clicked");

  // Where a joined member lands differs by branch, so the durable claim is that
  // they stop being asked to review an invitation and see no failure.
  await waitFor(browser, `!/one click away from the team workspace/i.test(document.body?.innerText ?? "")`, {
    timeoutMs: 90_000,
    label: "the invitation resolved after joining",
  });
  await screenshot(browser);

  const joined: unknown = JSON.parse(String(await evalIn(browser, `(() => {
    const text = document.body.innerText;
    return JSON.stringify({
      landedPath: window.location.pathname,
      stillReviewingAnInvitation: /one click away from the team workspace/i.test(text),
      failed: /something went wrong|couldn't|could not|error/i.test(text),
      text: text.replace(/\\s+/g, " ").slice(0, 240),
    });
  })()`)));
  expect(readBooleanField(joined, "stillReviewingAnInvitation")).toBe(false);
  expect(readBooleanField(joined, "failed")).toBe(false);
  evidence.fact(
    "Someone who only has SSO can finish joining, without ever setting a password",
    `After accepting, the browser was on ${readStringField(joined, "landedPath")} showing: ${readStringField(joined, "text")}`,
    true,
  );
});
