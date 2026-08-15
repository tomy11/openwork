# Handoff — mega eval lanes + product fixes

## ⚠️ First: do NOT reuse this worktree. Start fresh on an internal disk.

This work ran in `/Users/benjaminshafii/OpenWork-worktrees/mega-evals`, which is on an
**external HDD (`/Volumes/Extreme Pro`)**. That directly caused hours of false failures —
treat none of them as product bugs:

- **colima's VM datadisk died** mid-session (`Invalid virtual machine configuration.
  The storage device attachment is invalid.`) → Docker/kind gone → the kube lane (S3)
  could not be re-stamped on head.
- **MySQL wedged** with ~11,400 stale `TIME_WAIT` sockets on `127.0.0.1:3306` that
  stopped decaying; I moved local MySQL to **port 3310** as a workaround.
- Sidecar downloads and Electron rebuilds are slow/fragile on the external volume.

**Start like this (internal SSD only):**
```bash
cd ~/dev            # anywhere on the internal disk
git clone git@github.com:different-ai/openwork.git ow-mega && cd ow-mega
git fetch origin feat/mega-lifecycle-evals && git checkout feat/mega-lifecycle-evals
pnpm install --frozen-lockfile
```
On an internal disk you should NOT need the `:3310` MySQL workaround — use the normal
`pnpm dev:den:mysql` on 3306 and drop `OPENWORK_EVAL_MYSQL_URL` from the commands below.

## Where things stand

Branch `feat/mega-lifecycle-evals`, PR **#3668** against `dev`. Head at handoff: `77ea004d5`.

### Green on head (verified)
- **`org-team-lifecycle-mega.slow.test.ts`** — Daytona, `gpt-4o`, `VISION=defer` + `fraimz:judge`. 6-phase journey: invite → org provider → real model run → chat-authored Cloud skill → person-scoped marketplace share → teammate uses the shared skill (MCP connector is the witness). 13 deterministic facts + judged vision claims.
- **`self-host-onboarding.slow.test.ts`** — local. **Requires PR #3681's fix to pass** (see below); it is otherwise complete and correct.
- **`testkit-app-boot.slow.test.ts`** — proves the `OPENWORK_EVAL_ELECTRON_BINARY` prod-binary primitive against a packaged `.app`.
- **`kube-egress-allowlist.test.ts`** — passed at 77s, but its tape is on an **older commit** (`fc8b43b53`) because colima died. **Needs a re-stamp on head** (see task 3).

### Primitives added (reusable)
- `OPENWORK_EVAL_ELECTRON_BINARY` — spawn a packaged prod desktop build (local + Daytona).
- `selfHostServer()` — empty single-org Den, no seed.
- `--kube-egress allowlist` — kind + Calico default-deny egress + NetworkPolicy fixtures.
- `mcpMock({ allowUnauthenticatedMcp })`.
- **Deferred vision judging** — `OPENWORK_EVAL_VISION=defer` keeps LLM calls out of pass/fail; `pnpm --dir evals fraimz:judge -- --roll <dir|latest>` resolves them afterward (exit 0 pass / 1 fail / 2 pending). This was the key fix: an unbounded vision fetch was the real cause of the "300s Daytona flakes".
- Local-Den **Redis preflight** (this branch, `77ea004d5`) — see "Environment" below.

## Open PRs — MERGE ORDER MATTERS

1. **#3662** `fix(labs): handshakes()` — ✅ already merged.
2. **#3677** `fix(den-api): branded connector-target ids` — ✅ already merged (unbroke `dev`).
3. **#3681** `fix(den-api): invalidate org members cache on join` — ✅ **CLEAN, merge this next.**
   - This is the product bug that currently makes S2 fail: #3679's 60s member cache is
     never invalidated when a membership is created, so a just-joined member is invisible
     to `/v1/org`. One-line fix + unit test (fails without, passes with). I proved it
     end-to-end: with the patch applied, S2 passes in ~22s; without it, fails twice.
4. **#3668** (this branch) — ⏳ BLOCKED only on the merge chain above. After #3681 merges,
   merge `dev` into this branch and S2 goes green.

## Remaining tasks to finish #3668

**Task 1 — merge #3681, then rebase this branch and re-run S2.**
```bash
gh pr merge 3681 --squash --delete-branch      # if not already merged
git fetch origin dev && git merge origin/dev --no-edit
pnpm install --frozen-lockfile
# re-run S2 (Redis + MySQL must be up — see Environment):
OPENWORK_EVAL_APP_SPECS=1 OPENWORK_EVAL_VISION=defer \
  infisical run --silent -- env -u DATABASE_HOST \
  pnpm --dir evals exec vitest run --config vitest.config.ts --project stack specs/self-host-onboarding.slow.test.ts
# then judge its vision claims:
infisical run --silent -- pnpm --dir evals fraimz:judge -- --roll latest
```
Expect green (~22s). If `dev` moved again, re-run the mega too (Task 4).

**Task 2 — re-run every spec on the FINAL head and re-publish tapes.**
Tapes bind to a commit SHA; any merge invalidates them. On the final head, run all four
specs, `fraimz:judge` each roll to 0 pending, then:
```bash
infisical run --silent -- pnpm fraimz:publish -- --pr 3668 --roll <dir>   # once per roll
```
Note: this repo's `fraimz:publish` REPLACES the sticky comment per roll (no `--all`, no
accumulation). I worked around that with a consolidated verification comment on the PR —
keep doing that, or improve the publisher (nice-to-have, not required).

**Task 3 — re-stamp the kube lane on head** (needs working Docker/colima on the internal disk):
```bash
pnpm evals --stack kube --kube-egress allowlist --images published
OPENWORK_EVAL_KUBE_EGRESS_SPEC=1 OPENWORK_EVAL_DEN_API_URL=http://127.0.0.1:8790 \
OPENWORK_EVAL_DEN_WEB_URL=http://127.0.0.1:3005 OPENWORK_EVAL_KUBE_ALLOWED_HOST_IP=<printed by harness> \
pnpm --dir evals exec vitest run --config vitest.config.ts --project pr specs/kube-egress-allowlist.test.ts
```

**Task 4 — mega re-run command (reference):**
```bash
OPENWORK_EVAL_DAYTONA=1 OPENWORK_EVAL_APP_SPECS=1 OPENWORK_EVAL_MEGA_SPEC=1 \
OPENWORK_EVAL_MODEL=gpt-4o OPENWORK_EVAL_VISION=defer \
infisical run --silent -- env -u DATABASE_HOST \
pnpm --dir evals exec vitest run --config vitest.config.ts --project stack specs/org-team-lifecycle-mega.slow.test.ts
```
Cold Daytona provision can take ~15 min before the test body starts; the spec's timeout
is 45 min. It has passed cleanly multiple times; if it dies, check the failing phase in
the log tail before assuming a regression.

## Environment gotchas (all learned the hard way)

- **`env -u DATABASE_HOST`** is mandatory in front of every command: Infisical injects an
  empty `DATABASE_HOST` that fails den-api's env validation.
- **Redis is now required** for local Den (since `dev`'s #3679). Brew's Redis 8.x config
  references missing modules and won't boot; run a clean instance instead:
  ```bash
  redis-server --port 6379 --daemonize yes --save '' --appendonly no
  redis-cli ping   # expect PONG
  ```
  The testkit preflight (this branch) will tell you this exact command if Redis is down.
- **MySQL**: on an internal disk, plain `pnpm dev:den:mysql` on 3306 should be fine. Only
  if you hit TIME_WAIT exhaustion again do you need a spare port + `OPENWORK_EVAL_MYSQL_URL`.
- **Daytona CLI is a version behind the API** (v0.200.1 vs v0.203.0) — harmless warning,
  but `brew upgrade daytonaio/cli/daytona` removes the noise.
- Prod desktop build for the P1 lane: `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @openwork/desktop package:electron:dir` → `apps/desktop/dist-electron/mac-arm64/OpenWork.app/...`.

## Product issues filed (owned elsewhere, do not block #3668)

- **#3671** — org-published LLM providers never finish syncing to desktops ("Syncing"
  forever). Reproduced with an untouched spec on clean `dev`. This is WHY the mega routes
  its real model through workspace-scoped config instead of the org-provider path.
- **#3672** — Den-hosted Automation never materializes a run row (`latestRun` null while
  `state=active`). This is WHY the Automation phase was removed from the mega.
- **#3673** — `automations-den-hosted.slow.test.ts` targets a stale Automations UI
  (route/labels/casing drift, all documented with source refs).

## Deliberately out of scope (future PRs)
- Windows sandbox lane (needs a Windows host in `@openwork/hosts`; the binary primitive
  was designed to slot into it).
- Baking a Linux AppImage into the `openwork-eval-vnc` snapshot so Daytona desktops run
  the prod build (removes the Vite dev server — the biggest remaining sandbox-stability win).
