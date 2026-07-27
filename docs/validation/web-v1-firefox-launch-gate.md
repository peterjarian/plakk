# Web v1 Firefox launch-gate evidence

This document is the durable, sanitized evidence record for issue #133. It follows the
completed-Snippet lifecycle protocol: each scenario is classified as **observed as expected**,
**discrepancy observed**, or **blocked before observation**. Controlled browser fixtures and
deterministic tests are identified as such and are not presented as real account, provider,
billing, deployment, or telemetry evidence.

## Revision and environment

- Product revision under validation: `ac5ad9673719a6c6975ad542a208420903d1794c`, the exact
  `origin/main` commit containing the squash-merged #132 work.
- Tested Firefox harness revision: `12ac8f9363ed1734f1535e372a566670bcaa8ad4`. The later
  evidence-only commit does not change the tested Web or Playwright source.
- Evidence branch: `codex/issue-133-firefox-launch-gate`.
- Date: 2026-07-27, Europe/Amsterdam.
- Host: Linux x86_64, kernel `7.0.0-28-generic`.
- Desktop session: accessible XFCE X11 session, 1280 by 1040. The shell inherited only the
  session variables selected by the repository Linux helper; toolkit accessibility was enabled.
- Browsers: system Firefox 153.0 and Playwright Firefox 153.0 (Playwright build v1538).
- Toolchain: Node.js 24.18.0, Vite+ 0.2.5, pnpm 11.9.0.
- Profile boundary: Playwright used its isolated ephemeral browser contexts. The hosted auth-entry
  check used a new disposable system-Firefox profile with no saved account state. It was removed
  after the observation. No developer browser profile was read, copied, reset, or reused.
- Account boundary: controlled scenarios used synthetic fixture identities. No real account
  identifier, credential, provider identifier, filename, Snippet content, authorization code,
  signed URL, cookie, or trace payload is recorded here.

## Ownership audit

Issue #133 validates the existing product and records evidence. The only code change found
necessary is owned by the Web Playwright harness: a Firefox setup-project dependency waits for the
controlled Vite application to warm before parallel Firefox scenarios begin. Product ownership
remains unchanged:

- Web orchestration and browser persistence stay in `apps/web`.
- Backend and shared contracts remain authoritative for authentication, account entitlement,
  provider state, Snippet commands, and telemetry export.
- Desktop retains Electron lifecycle and native-shell ownership.
- No shared client runtime, provider abstraction, browser matrix, deployment pipeline, or product
  behavior was added.

## Scenario record

| Evidence layer and scenario                                                                                                                                                              | Classification                 | Actual observation or blocker                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted canonical auth entry in a fresh system-Firefox profile                                                                                                                            | **observed as expected**       | `https://app.plakk.io` selected the canonical app callback and reached the WorkOS sign-in surface. No account input was entered.                                                                                                                                                                           |
| Local signed-out Welcome and WorkOS auth entry                                                                                                                                           | **observed as expected**       | The repository Web task served `http://localhost:3000` in Firefox with the signed-out product and sign-in action. WorkOS auth entry used `http://localhost:3000/api/auth/callback`; no credential or account input was entered.                                                                            |
| Hosted signed-out Welcome                                                                                                                                                                | **discrepancy observed**       | The hosted root redirected directly to AuthKit instead of showing the Welcome surface exercised by the current local build. The deployed revision could not be established.                                                                                                                                |
| Full real-account journey: sign-in, automatic trial, linked storage, text/file publication, second-tab convergence, Copy/Download/Open, deletion, sign-out, and second-account isolation | **blocked before observation** | No isolated signed-in Firefox profile or two test-account inputs were supplied. The local callback was observed, but no account authentication was attempted and the journey was not represented as passing.                                                                                               |
| Controlled trial, restricted mode, blocked normal actions, preserved rows/Delete/recovery/Settings/help/sign-out, and backend-confirmed recovery presentation                            | **observed as expected**       | Firefox exercised active trial, exact-expiry restriction, billing-only, storage-only, simultaneous blockers, independent recovery ordering, and retained destructive/recovery actions through controlled product states.                                                                                   |
| Complete lifecycle against one real storage provider                                                                                                                                     | **blocked before observation** | No signed-in account with a configured WorkOS Pipes provider was available. No provider object was created or inspected.                                                                                                                                                                                   |
| Focused real Google Drive, OneDrive, and Dropbox connection and browser-transfer boundaries                                                                                              | **blocked before observation** | The three provider dashboard connections and test accounts were not available to this Linux profile. Controlled fixtures exercised equal choice, redirect sanitization, direct transfer, cancellation, temporary failure, reauthorization, cleanup, and retry but do not establish real provider behavior. |
| Real Polar sandbox checkout and recovery                                                                                                                                                 | **blocked before observation** | Sandbox credentials, products, paid benefit, webhook, and an authenticated test account were unavailable. No checkout was started.                                                                                                                                                                         |
| Deterministic trial, early-upgrade, false-success, cancellation, paid-through, grace, expiry, webhook, recovery, and command-authorization boundaries                                    | **observed as expected**       | The complete repository test suite passed, including backend billing authority/account capability and Web billing/restricted-state coverage. Firefox also exercised the controlled checkout-return gate and backend-confirmed recovery presentation.                                                       |
| Concurrent multi-tab OPFS SQLite open, convergence, ownership handoff, close, reopen, interrupted write, and purge                                                                       | **observed as expected**       | The repository-owned Firefox scenario used the real Web mirror worker and OPFS implementation across concurrent tabs. The settled full Firefox run completed this scenario.                                                                                                                                |
| Forced SQLite/OPFS-unavailable session-memory fallback and notice                                                                                                                        | **observed as expected**       | Firefox selected the session-memory adapter, kept the online Home workflow available, and displayed the degraded-performance notice without presenting an unsupported-browser state.                                                                                                                       |
| Controlled canonical auth and storage return sanitization                                                                                                                                | **observed as expected**       | Firefox preserved requested routes, rejected an untrusted nested return, required authoritative storage confirmation, and distinguished Web-origin and Desktop-origin completion.                                                                                                                          |
| Real canonical storage return                                                                                                                                                            | **blocked before observation** | A real provider authorization could not be started without the provider/dashboard setup and signed-in account.                                                                                                                                                                                             |
| Controlled API outage, retained mirror, blocked remote work, stream reconnect, and complete refresh                                                                                      | **observed as expected**       | Firefox retained the last-confirmed controlled snapshot, showed a retryable API-unavailable state, did not present an empty account or sign-out, and converged after recovery.                                                                                                                             |
| Production API availability                                                                                                                                                              | **discrepancy observed**       | `https://api.plakk.io` did not resolve in DNS. This production-only observation is outside the local Linux gate and does not block local E2E or issue completion.                                                                                                                                          |
| Backend authorization and sanitization boundaries                                                                                                                                        | **observed as expected**       | Deterministic backend/shared tests exercised bearer-token middleware, account/storage/billing command authorization, exact-origin CORS, telemetry proxy authorization/rate limits, propagation, and protected-field sanitization. This is not a live production request.                                   |
| Joined sanitized frontend/backend trace visible in Axiom                                                                                                                                 | **blocked before observation** | No local OTLP/Axiom exporter configuration or Axiom query/dashboard observer was supplied. No joined trace visibility is claimed.                                                                                                                                                                          |
| Canonical marketing origin                                                                                                                                                               | **discrepancy observed**       | `https://plakk.io` returned Vercel `DEPLOYMENT_NOT_FOUND`. This production-only observation is outside the local Linux gate; issue #133 did not authorize deployment changes.                                                                                                                              |

## Local development reassessment

The root `vp run dev` task invokes Web, backend, and Desktop development tasks in parallel. On this
host, the aggregate command stopped because the unrelated Desktop native rebuild could not find
`make`. The repository Web and backend tasks were therefore launched directly with the saved
development configuration and these documented public local values:

- `WORKOS_REDIRECT_URI=http://localhost:3000/api/auth/callback`
- `PLAKK_WEB_ORIGIN=http://localhost:3000`
- `VITE_PLAKK_API_ORIGIN=http://localhost:3100`

Firefox observed the local signed-out product at port 3000 and reached the external WorkOS auth
entry with the exact local callback. The local backend listened on `127.0.0.1:3100`, then failed
closed because `POLAR_ACCESS_TOKEN` was absent. No synthetic Polar credential was substituted.
Production deployment or DNS is not a prerequisite for this local path.

## Firefox harness discrepancy and correction

The first dedicated Firefox run completed 49 of 50 tests. During the acceptance-critical initial
two-tab mirror navigation, both pages requested Vite optimized-dependency URLs while the controlled
development server was still replacing its cold dependency graph. Firefox rejected the empty-MIME
responses, so the application and mirror never initialized. This was a harness readiness defect,
not an OPFS or product failure.

The Playwright Firefox setup-project dependency now opens the controlled product once and waits up
to 30 seconds for its Home heading before parallel Firefox tests begin. Chromium-only runs do not
execute this Firefox setup. The simultaneous two-tab mirror navigation remains unchanged. After
moving the generated Vite cache aside, the final targeted setup/mirror/fallback graph completed 3
of 3 tests. The final full Firefox dependency graph completed 51 of 51 tests.

An earlier mixed-browser diagnostic invocation completed 99 of 100 tests and had one Chromium-only
controlled billing presentation miss while the equivalent Firefox scenario completed. Chromium is
not launch evidence for this ticket and no Chromium result substitutes for Firefox. The diagnostic
result is retained here rather than hidden.

## Commands and gates

| Command                                                                                                              | Result                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./node_modules/.bin/playwright test e2e/readable-mirror.spec.ts --project=firefox` from a cold controlled-app cache | 3 tests passed, including the Firefox setup dependency                                                                                                    |
| `./node_modules/.bin/playwright test --project=firefox`                                                              | 51 tests passed, including the Firefox setup dependency                                                                                                   |
| `./node_modules/.bin/playwright test e2e/auth-routing.spec.ts --project=chromium`                                    | 3 tests passed without executing the Firefox setup                                                                                                        |
| `vp test`                                                                                                            | 95 files and 559 tests passed                                                                                                                             |
| `vp check`                                                                                                           | 449 files formatted; 310 files checked with no warnings, lint errors, or type errors                                                                      |
| `vp run typecheck`                                                                                                   | All seven workspace tasks completed with no type errors; the Effect language service emitted one non-failing pre-existing suggestion in the mirror worker |
| Production `@plakk/web` build with synthetic non-secret values for the documented required environment names         | Client, SSR, and Nitro production builds completed                                                                                                        |

The production-build environment contained only synthetic values and the canonical public origins.
The names supplied were `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI`,
`WORKOS_COOKIE_PASSWORD`, `VITE_PLAKK_API_ORIGIN`, `VITE_PLAKK_ENVIRONMENT`,
`VITE_PLAKK_RELEASE`, and `PLAKK_WEB_ORIGIN`. No backend or Desktop source changed, so no affected
backend or Desktop build exists for this evidence branch.

## Local credentials and configuration required for live completion

The following work remains outside this Linux task and must be completed without copying secrets
into this evidence record:

1. Supply an isolated Firefox profile/session with two test accounts authorized for the observed
   local WorkOS callback.
2. Configure WorkOS Pipes connections and usable test accounts for Google Drive, OneDrive, and
   Dropbox.
3. Configure Polar sandbox values `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`,
   `POLAR_MONTHLY_PRODUCT_ID`, `POLAR_ANNUAL_PRODUCT_ID`, `POLAR_PAID_BENEFIT_ID`, and
   `POLAR_SERVER=sandbox`, including the sandbox customer-state webhook and paid benefit.
4. Provide local OTLP/Axiom exporter configuration and Axiom query access for the joined sanitized
   browser/backend trace. Infrastructure configuration uses `AXIOM_TOKEN` and, when applicable,
   `AXIOM_ORG_ID`.

Until the blocked live scenarios are observed, issue #133 is not a completed launch gate and this
evidence must not be used to merge or close it.
