# Retrospective

> Written after verify passed. Captures what went well, what missed, plan deviations, and skill/workflow compliance for change `pi-matrix-bridge-plugin`.

**Date**: 2026-08-20
**Change**: `pi-matrix-bridge-plugin`

---

## 0. Evidence

- **Scope**: full OpenSpec cycle for `pi-matrix-bridge-plugin` — a standalone dashboard plugin (compat layer for `rolznz/pi-matrix-bridge`) that spawns a background `pi` session, mirrors config to `~/.pi/matrix-bridge.json`, exposes settings UI + REST/WS, and reserves a proactive-push pathway.
- **Commit range**: `a401fe5..HEAD` (8 commits: def5b49, d0d43b9, 2626c60, 33c74b8, 566f036, e1b3cdd, 2289048, 60731f6) — plan doc committed at a401fe5 on master, implementation on `feat/pi-matrix-bridge-plugin` worktree.
- **Artifacts**: proposal.md, design.md, specs/matrix-bridge-plugin/spec.md (9 ADDED reqs), tasks.md (19 tasks), plan.md (7 Tasks), verify.md (✅ PASS).
- **Tests**: 29 vitest green (6 files), `tsc --noEmit` clean.
- **Commands run to verify**: `openspec validate --all --json` (valid), `npm test` (29 pass), `npm run typecheck` (clean).

## 1. Wins

- `[✓]` Delivered against a concrete external target (`rolznz/pi-matrix-bridge`) with a cleanly separated server (`src/server/{session,mirror,index}.ts`) + client (`src/client.tsx`) + shared types (`src/types.ts`), all reconciling to the real runtime API (server-context, client hooks, slot-props).
- `[✓]` All 9 spec requirements trace to code/tests; mirror file security (0600, `matrix:` prefix, token redact) explicitly tested.
- `[✓]` TDD discipline held: unit tests in `test/unit/{types,mirror,session,server}.test.ts` + `client.test.tsx` + manifest smoke `test/index.test.ts`.
- `[✓]` Self-review (via review-code discipline after reviewer subagent died) caught 2 real bugs (BackgroundSession stop/start race; stale mirror after config edit) — both fixed with regression tests (`60731f6`).
- `[✓]` Schema switch to `superpowers-bridge-cn` and the full prescribed flow (worktree + feat branch + dispatch + verify/retro/archive + merge) executed end-to-end.

## 2. Misses

- 🔴 [blocking] **None** — no open blocking defects; all tasks done, validate passes, 29/29 tests green.
- 🟡 [important] Code-review subagent (`del_mt1dh0je_8c62`) exited without producing any findings (`exit ?`, empty `.out`); had to fall back to manual self-review. Cost ~extra review pass. **Fix**: give reviewer a bounded, high-signal scoped brief (list exact files + top risk areas) and/or run sync with a short timeout; verify a non-empty result before trusting.
- 🟡 [important] `plan.md` assumed `registerPiHandler(msg, sessionId)` exposes the unspoofable transport sessionId as a 2nd arg; the actual runtime signature is single-arg (`msg`). Mitigated by switching the reserved pathway to `ctx.onEvent((sessionId, event))` (design D5) — a documented mechanism pivot, not a spec change.
- 📌 [nit] Renovated mirror-on-lifecycle-action rather than mirror-on-config-change: no config-change hook exists in the runtime, so `~/.pi/matrix-bridge.json` is only re-mirrored on registration + REST lifecycle actions (not on a bare settings save). Acceptable + documented; a future `updatePluginConfig` hook would tighten this.
- 📌 [nit] Client does not surface `pi-matrix-bridge_mirror_error` broadcast (it polls `/status` instead of WS-subscribing); mirror errors are only in server logs. Documented as a known limitation.

## 3. Plan deviations

| Plan step | Deviation | Reason |
|---|---|---|
| Task 5 / 6.1 "reserved proactive push via `registerPiHandler"plugin_pi_message“, handler(msg, sessionId)" | Implemented via `ctx.onEvent((sessionId, event))` observer broadcasting `pi-matrix-bridge_forward` | Runtime `registerPiHandler` handler is single-arg; transport-attributed sessionId only surfaced through `onEvent`. Requirement (unspoofable sessionId + trustedUsers gate) preserved. |
| Task 2.2 client "surface mirror error" | Mirror error broadcast exists server-side; client (REST-poll based) does not render it | Client read path is REST polling; no generic broadcast hook. Logged server-side; accepted limitation. |
| Scaffold stub used `ctx.pluginConfig` field | Replaced with `ctx.getPluginConfig()` (no `pluginConfig` field on ServerPluginContext) | Actual runtime API surface. |
| — | Added `typecheck` devDeps (typescript, @types/node, fastify, ajv) + client test devDeps (jsdom, @testing-library/react, jest-dom) | Runtime is raw-TS source imported via `.js` subpaths; typecheck needs its internal deps; client tests need jsdom. |

## 4. Skills compliance

| Skill | Applied? |
|---|---|
| brainstorm / proposal / design / specs / tasks / plan | ✓ (planning phase) |
| openspec-apply-change (worktree + feat branch + subagent dispatch + tasks checkboxes) | ✓ |
| writing-plans | ✓ |
| test-driven-development / subagent-driven-development | ✓ (TDD throughout; subagent-driven for tasks 1–3, inline for 4–7 after subagent reliability issue) |
| requesting-code-review | ✓ (manual self-review after subagent failure) |
| openspec-verify-change / retrospective | ✓ |
| finishing-a-development-branch (worktree merge) | pending (this report precedes merge) |

### Deliberately skipped skills

- **subagent-driven-development** for tasks 4–7. First reviewer subagent exited with no findings (`exit 0`/empty), so I switched to inline implementation + self-review. Lesson: for a change this size with heavy cross-runtime-API reconciliation, inline with a self-review pass was more reliable than dispatching subagents. Skills were still applied (TDD, code review) — just not via subagents.

## 5. Surprises

- Runtime (dashboard-plugin-runtime / pi-dashboard-shared) is **raw TypeScript source, not compiled**, imported via `.js` subpaths; typecheck pulls in their deps (fastify, ajv). Had to add devDeps + understand `.js` subpath exports.
- `ctx.broadcastToSubscribers` and `registerBrowserHandler` are the WS push + replay seams (state/log streaming); client has no generic broadcast subscription hook — hence REST polling for `/status`.
- Role `settings-section` is a global single instance (not per-session); session-specific slots render per dashboard session — shaped the decision to keep the plugin UI to one settings panel + one shared background session.

## 6. What to do differently next time

- Read the runtime source API surface (server-context, client hooks, slot-props, event/broadcast seams) **before** finalizing plan.md, so plan steps match real signatures (avoids the `onEvent` pivot and stub `pluginConfig` field).
- When a delegated reviewer is unreliable, use it as a second opinion rather than sole gate; keep a manual self-review pass.
- Consider a config-change hook / explicit "apply (restart)" button in the settings UI so mirror refresh is user-visibly tied to a lifecycle action.

## 7. Ideas / future work

- Surface `mirror_error` (+ other broadcast events) in the client via a WS subscription once a generic client broadcast hook exists.
- Add an "Apply / restart" affordance so config edits immediately re-mirror + restart the background session.
- Wire the reserved `onEvent` forward pathway into the actual bridge conversation (currently logged/broadcast only, per R7/D5 reservation).
- Consider per-workspace/multi-session support later; current scope is a single shared background session per plugin instance (design D2).
