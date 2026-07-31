# VOX ↔ Auto ChatGPT Images Auth and Bridge Test Plan

## Document status

- Status: **Proposed — no runtime implementation yet**
- Contract under test: `docs/vox-auth-bridge-contract.md` revision `0.1`
- Automation protocol: `vox-chatgpt/1`
- Last updated: 2026-07-29

## Purpose

This plan defines the evidence required before authenticated VOX integration is
enabled. It protects the currently working standalone extension and local VOX
flow while auth, bridge, batch ownership, reference delivery, and result
receipts are added.

## Safety constraints

- Do not modify production VOX data during automated tests.
- Do not use a real user's production access or refresh token in fixtures.
- Do not automate around ChatGPT login, verification, safety, or usage limits.
- Do not submit a real ChatGPT prompt in auth/bridge unit tests.
- Use fake VOX and fake ChatGPT DOM adapters wherever the test does not require
  browser compatibility.
- Never print authorization headers, token bodies, image data URLs, or raw
  refresh tokens in test output.
- Preserve and continuously rerun the current standalone extension suite.

## Baseline before implementation

Before changing runtime code:

1. Record the extension and VOX commit/worktree state.
2. Run the current extension checks:

   ```text
   npm run check
   npm test
   ```

3. Run the current VOX typecheck, tests, and build commands documented by VOX.
4. Manually confirm the existing localhost path:
   - VOX creates a batch.
   - Extension receives the batch.
   - ChatGPT receives ordered references and one prompt.
   - Extension returns image bytes.
   - VOX saves the result and updates the intended beat.
5. Capture sanitized fixtures for the current bridge and batch payload.

If the baseline is not green, auth implementation must not begin.

## Test environments

| Environment | VOX origin | Extension | Auth mode | Data |
| --- | --- | --- | --- | --- |
| Unit | none | modules only | fake | deterministic fixtures |
| Integration | local test server | test build | fake OAuth/PKCE | temporary database/files |
| Local compatibility | localhost/127.0.0.1 | unpacked | development bypass | disposable project |
| Staging | official staging HTTPS origin | staging extension ID | real staging auth | test workspace |
| Production smoke | official production HTTPS origin | store build | production auth | dedicated canary workspace |

Production credentials and production user projects are forbidden in automated
integration tests.

## Required test fixtures

- VOX user A in workspace A.
- VOX user B in workspace B.
- Two extension connections for user A.
- Revoked connection.
- Expired access token.
- Rotated and replayed refresh token.
- Single-use authorization codes with correct and incorrect PKCE verifiers.
- Owned and foreign batches.
- Active, expired, and mismatched task leases.
- References with valid, missing, oversized, wrong-MIME, and wrong-checksum
  bytes.
- Existing ChatGPT images before submission.
- Generated result with deterministic bytes and checksum.
- Duplicate and conflicting result submissions.

All token-like fixtures must be obviously synthetic and unusable outside the
test environment.

## Extension unit tests

### PKCE

- Generates a verifier with at least 256 bits of entropy.
- Verifier length is between 43 and 128 characters.
- Verifier contains only permitted unreserved characters.
- Challenge equals base64url-without-padding SHA-256 of the verifier.
- Generates unique verifier and state values for every attempt.
- Rejects callback state mismatch.
- Rejects callback without an authorization code.
- Clears verifier, state, and authorization code after success, failure, cancel,
  or timeout.
- Never falls back from `S256` to `plain`.

### Token lifecycle

- Stores only required connection metadata and the active refresh token.
- Refreshes shortly before or after access-token expiry.
- Rotates refresh token atomically.
- Never reuses the old token after a successful rotation.
- Stops and disconnects on refresh-token replay/revocation response.
- Retries an API request at most once after refresh.
- Redacts tokens from thrown errors and diagnostic logs.
- Disconnect revokes first and clears local state even when the revoke response
  is already-revoked.

### Origin and bridge validation

- Accepts registered production VOX origin.
- Accepts loopback origins only when the local-development flag is enabled.
- Rejects HTTP production origins.
- Rejects arbitrary ports/domains and lookalike domains.
- Rejects events whose source is not the top-level window.
- Rejects protocol major-version mismatch.
- Rejects unknown message types and malformed payloads.
- Correlates every response with the exact request ID.
- Never accepts a page-supplied token, subject, workspace, or connection ID.
- Never includes tokens in bridge responses.

### Connection state

- Represents disconnected, connecting, connected, refreshing, expired,
  revoked, wrong-workspace, and unreachable states.
- Does not start interactive auth on extension installation or panel open.
- Starts interactive auth only after an explicit user action.
- Restores safe connection display state after service-worker termination.

## VOX auth unit tests

### Authorization request

- Rejects unknown client IDs.
- Rejects unregistered redirect URIs, including prefix and wildcard variants.
- Rejects missing PKCE.
- Rejects `code_challenge_method=plain`.
- Rejects malformed or weak challenges.
- Preserves the requested scopes through login and consent.
- Requires explicit consent for a new connection.
- Issues a code bound to subject, workspace, client, redirect URI, scopes, and
  challenge.
- Authorization code expires within the approved lifetime.

### Token endpoint

- Exchanges a valid unused code and correct verifier.
- Rejects wrong verifier.
- Rejects code replay.
- Rejects expired code.
- Rejects redirect mismatch.
- Rejects client mismatch.
- Access token contains/verifies subject, workspace, connection, audience,
  scopes, issued time, and expiry.
- Token endpoint never issues a client secret to the extension.

### Refresh and revocation

- Rotates refresh tokens on every successful refresh.
- Invalidates the previous refresh token.
- Detects replay and revokes the token family.
- Enforces inactivity expiry.
- Disconnect revokes access and refresh capability.
- Workspace removal and account disablement revoke or deny the connection.
- Revocation is idempotent.

## VOX extension API authorization tests

- Missing token returns `401 VOX_AUTH_REQUIRED`.
- Expired token returns `401 VOX_AUTH_REQUIRED`.
- Wrong audience is rejected.
- Missing scope returns `403 VOX_SCOPE_REQUIRED`.
- Revoked connection returns `401 VOX_CONNECTION_REVOKED`.
- Workspace A token cannot read or claim workspace B batch.
- Subject/workspace values in request JSON are ignored as authority.
- Production routes do not accept the local development bypass.
- Local development bypass accepts only loopback requests when enabled.
- CORS never returns `*` in authenticated mode.
- CORS allows only registered extension origins.

## Batch and lease tests

- Authenticated VOX web session creates a batch owned by its subject/workspace.
- Extension can read only owned batches.
- Claim issues a unique lease token and expiry.
- Server stores only the approved representation or hash of the lease token.
- Progress with a valid lease renews expiry and increments revision.
- Missing lease is rejected.
- Wrong lease is rejected.
- Expired lease is rejected or reconciled according to policy.
- Stale task revision returns `412 STALE_TASK_REVISION`.
- A second connection cannot mutate an actively leased task.
- An expired task may be reclaimed exactly once.
- Repeated `START_CHATGPT_BATCH` reconnects without duplicating tasks.

## Reference delivery tests

- Production batch rejects `data:` reference URLs.
- References are returned in declared order.
- Extension downloads reference bytes from the authenticated service worker.
- Access token never reaches ChatGPT page context.
- Valid checksum, MIME, and size are accepted.
- Missing reference returns a stable error and blocks submission.
- Wrong checksum blocks submission.
- Wrong MIME or non-image content blocks submission.
- Oversized reference blocks submission.
- Partial set never silently proceeds.
- Service-worker restart resumes resolution without changing reference order.

## Result receipt tests

- Valid lease, revision, idempotency key, checksum, and bytes save once.
- Receipt echoes the matching batch, task, project, beat, asset, and checksum.
- Same idempotency key and checksum returns the original receipt with
  `duplicate: true`.
- Same idempotency key and different checksum returns `409 RESULT_CONFLICT`.
- Wrong beat/task/batch relationship is rejected.
- Missing or expired lease is rejected.
- Invalid image MIME, empty bytes, oversized bytes, and checksum mismatch are
  rejected.
- Task is completed only after the durable receipt is returned.
- Network loss after save is recovered by idempotent result retry.
- `associationMode=batch_task_identity` is surfaced to the VOX page.
- VOX local-storyboard attachment failure is reported separately without
  deleting the saved asset.

## Integration tests with fake VOX and fake ChatGPT

### Happy path

1. User connects with PKCE.
2. VOX creates a two-task batch.
3. Bridge sends only batch ID and API origin.
4. Extension fetches and claims task 1.
5. Extension resolves ordered references.
6. Fake ChatGPT accepts prompt exactly once.
7. Extension finds only the new image outside the baseline.
8. Extension uploads bytes and receives a durable receipt.
9. Task 2 executes sequentially.
10. Batch becomes completed.
11. VOX associates each receipt with the correct beat.

Assertions:

- Zero tokens appear in page messages or fake ChatGPT calls.
- Zero reference order changes.
- Zero duplicate prompt submissions.
- Zero stale-image returns.
- Exactly one saved asset per task idempotency key.

### Connection-required path

- VOX detects extension but disconnected account.
- No batch is created before connection unless an approved pending-intent design
  explicitly allows it.
- Side panel opens in connection state.
- Cancel leaves VOX unchanged.
- Successful auth returns VOX to batch creation without exposing tokens.

### Recovery path

Terminate or reload at each boundary:

- Before authorization callback.
- After code receipt but before token exchange.
- After access token receipt but before connection metadata save.
- After batch fetch.
- After claim.
- During reference download.
- After baseline.
- During reference upload.
- Immediately before submit.
- Immediately after submit.
- While waiting.
- After result bytes are collected.
- After VOX saves but before receipt reaches extension.

For every boundary, prove whether the system safely resumes, reconciles, or
requires explicit user action. Prompt submission must never be guessed.

## Browser/manual tests

### Chrome extension

- Supported minimum and current Chrome versions.
- Fresh extension install.
- Extension update with an existing local queue.
- Published/staging extension redirect URL.
- Auth popup completed, canceled, and closed.
- Side panel closed and reopened during auth and execution.
- Browser restart with connected and disconnected states.
- Revocation performed from VOX while the extension is open.

### VOX

- Logged out → login → consent → return.
- Logged in, correct workspace.
- Logged in, switch workspace before consent.
- User removed from workspace during execution.
- VOX page reload during active batch.
- Local storyboard missing when a saved receipt arrives.
- Same project open in two VOX tabs.

### ChatGPT

- Logged in.
- Logged out.
- Verification required.
- Usage limit reached.
- ChatGPT tab closed/reloaded.
- Existing assistant images in the conversation.
- Multiple ordered references.
- Generation timeout and retry.

Tests must not attempt to bypass any ChatGPT restriction.

## Security abuse tests

- Malicious page sends forged `START_CHATGPT_BATCH`.
- Allowed VOX page supplies a foreign batch ID.
- Iframe sends bridge messages.
- Lookalike domain attempts connection.
- Authorization response is replayed.
- Stolen authorization code is exchanged without verifier.
- Stolen access token is used against the wrong audience.
- Stolen refresh token is replayed after rotation.
- Task lease from another connection is reused.
- Result metadata attempts path traversal in output name.
- Multipart upload claims image MIME but contains non-image bytes.
- Reference download redirects to an unapproved origin.
- Logs and exported diagnostics are scanned for token-shaped values.

## Performance and limits

Measure:

- Connection check latency.
- Authorization completion time excluding user login time.
- Token refresh latency.
- Batch fetch and claim latency.
- Reference download memory usage for 1–5 images.
- Multipart result upload for the maximum approved result size.
- Service-worker restart recovery duration.

The exact pass thresholds require product approval. Security and correctness
gates are not waived for performance.

## Observability checks

Logs may contain:

- Timestamp.
- Extension version.
- Protocol version.
- Safe connection ID suffix or hash.
- Batch/task/beat/attempt IDs.
- State transitions.
- HTTP status and stable error code.
- Request correlation ID.
- Byte counts and checksums.

Logs must not contain:

- Access or refresh tokens.
- Authorization codes or PKCE verifier.
- Authorization headers.
- VOX session cookies.
- Raw image bytes or data URLs.
- ChatGPT credentials.

Automated tests should scan captured logs for these forbidden values.

## Rollout gates

### Gate 0 — Contract approval

- Product approves UX and two-mode policy.
- Security approves OAuth, token, CORS, and lease rules.
- VOX owner approves exact files and data changes.

### Gate 1 — Test-only scaffolding

- Fake OAuth server and fixtures.
- No production VOX routes changed.
- Current extension suite remains green.

### Gate 2 — Local compatibility

- Auth code remains feature-flagged off.
- Existing localhost flow completes without regression.
- New bridge handshake works additively.

### Gate 3 — Staging auth

- Staging Chrome extension ID and VOX origin registered.
- All unit, integration, recovery, and abuse tests pass.
- No sensitive values appear in logs.

### Gate 4 — Limited production

- Dedicated canary workspace.
- Small allowlisted user set.
- Kill switch and token revocation verified.
- Completion, duplicate, conflict, auth, lease, and attachment metrics visible.

### Gate 5 — General release

- Incorrect beat association: zero.
- Duplicate prompt submissions: zero in tested recovery windows.
- Stale image return: zero.
- Auth and revocation support documentation available.

## Rollback plan

- Disable `VOX_EXTENSION_ENABLED` to stop new production starts.
- Revoke affected extension connections.
- Preserve completed assets and receipts.
- Do not delete active batch records during rollback.
- Allow current ChatGPT operation to reach a safe boundary or mark it paused.
- Restore local development behavior only on loopback builds.
- Roll back bridge messages additively; unknown message types remain safely
  ignored.
- Reconcile tasks with active leases before re-enabling.

Rollback must never authorize a production batch through the local bypass.

## Required approval record

Before implementation, record:

- Approved production VOX origin.
- Approved extension IDs for development, staging, and production.
- Approved auth/session provider.
- Approved token and connection storage backend.
- Approved token lifetimes.
- Approved reference and result limits.
- Approved VOX files/modules that may be changed.
- Approved database/storage migration and rollback method.
- Reviewer names and approval date.

