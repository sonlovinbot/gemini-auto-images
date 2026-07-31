# Auto ChatGPT Images — Product Brief

## Document status

- Product: Auto ChatGPT Images
- Platform: Chrome Extension, Manifest V3
- Initial integration: VOX STYLE VIDEO
- Protocol version: `vox-chatgpt/1`
- Status: Initial product and architecture brief

## Summary

Auto ChatGPT Images is a Chrome extension that connects applications such as VOX STYLE VIDEO to a user's existing, logged-in ChatGPT browser session. It acts as an external image-generation executor: it receives image-generation tasks from an application, automates the corresponding ChatGPT workflow, retrieves the generated image bytes, and returns them to the originating application.

The first release focuses on reliable, sequential generation of storyboard images for VOX. VOX remains the system of record for projects, batches, tasks, attempts, and permanent assets. The extension is intentionally treated as an unreliable client whose service worker, tab, or browser may stop at any time.

## Problem

VOX users can create storyboards composed of many beats, but generating an image for every beat through ChatGPT requires repetitive manual work:

1. Find the correct references for a beat.
2. Upload them in the required order.
3. paste the correct prompt.
4. Wait for a new generated image.
5. Download the best available image.
6. Rename and attach it to the correct project and beat.
7. Repeat the process without mixing results between beats.

This workflow is slow and error-prone. A failed upload, stale image, duplicated prompt, browser reload, or incorrect beat association can corrupt a batch.

## Product vision

Provide a dependable bridge between creative applications and the user's own ChatGPT browser session, beginning with storyboard image generation for VOX and expanding later through integration adapters.

The extension should feel like a queue runner rather than a project-management system. It executes work, reports observable progress, and returns results; the connected application owns durable orchestration and assets.

## Goals

- Generate images for multiple VOX storyboard beats with minimal user intervention.
- Preserve the exact prompt, reference set, reference order, and output identity for every beat.
- Return actual generated image bytes to VOX.
- Recover safely from extension service-worker termination, tab reloads, browser restarts, and transient automation failures.
- Prevent stale images, duplicate submissions, and cross-beat result association.
- Support pause, resume, retry, stop, and recovery after reload.
- Establish a versioned protocol and adapter boundaries that can support other applications later.
- Produce actionable diagnostics without attempting to bypass ChatGPT restrictions.

## Non-goals

- Owning VOX projects, permanent assets, or the authoritative task queue.
- Bypassing ChatGPT login, verification, safety policies, rate limits, or usage limits.
- Running multiple ChatGPT generations concurrently in V1.
- Guaranteeing uninterrupted execution in a Manifest V3 service worker.
- Depending on temporary ChatGPT image URLs as permanent results.
- Building a general browser automation framework in V1.
- Automatically modifying or weakening a user's ChatGPT account settings.

## Primary user

A VOX creator who has:

- Completed a multi-beat storyboard.
- Prepared prompts and optional reference images for each beat.
- Logged in to ChatGPT in Chrome.
- Chosen to generate storyboard images through ChatGPT.

## Primary workflow

1. The user finishes a storyboard containing multiple beats in VOX.
2. The user clicks **Generate with ChatGPT** in VOX or opens the extension.
3. VOX creates a durable batch containing the project ID, beat IDs, prompts, aspect ratios, ordered reference images, expected output names, and attempt metadata.
4. The extension connects to VOX, claims eligible work, and opens or reuses a ChatGPT tab.
5. The extension creates or restores a dedicated ChatGPT conversation for the batch.
6. For each task, sequentially, the extension:
   1. Records a baseline of existing ChatGPT messages and images.
   2. Downloads or resolves the exact ordered references assigned to the beat.
   3. Uploads every reference and verifies that each upload succeeded.
   4. Submits the prompt exactly once.
   5. Waits for a new assistant response created after the baseline.
   6. Identifies the new generated image and retrieves the highest-quality available version.
   7. Sends the image bytes and task metadata to VOX.
7. VOX saves the image permanently and attaches it to the correct storyboard beat.
8. The extension marks its local execution complete only after VOX confirms the save.
9. The extension proceeds to the next task or reports a terminal or recoverable failure.

## Product principles

### VOX is the system of record

VOX owns:

- Projects and storyboards.
- Batches and task ordering.
- Task states and attempt history.
- Idempotency decisions.
- Permanent reference and generated assets.
- Final association between an image and a storyboard beat.

The extension may persist execution checkpoints locally, but local state is a cache and recovery aid, not the authoritative queue.

### The extension is an unreliable executor

The extension must assume that:

- Its Manifest V3 service worker can terminate between any two operations.
- Content scripts can be detached by navigation or reload.
- ChatGPT's DOM and labels can change.
- Network requests can time out after the server has accepted them.
- The user can close, reload, or manually interact with the ChatGPT tab.

Every important transition must therefore be recoverable, observable, and safe to repeat where possible.

### Correctness is more important than throughput

V1 processes one generation at a time. It never silently skips a reference, guesses which existing image is new, or marks a task complete before VOX confirms durable storage.

### Integrations are adapters

VOX-specific transport and payload mapping must sit behind an application adapter. ChatGPT page automation must sit behind a separate executor/page adapter. Queue orchestration should depend on stable internal interfaces rather than VOX endpoints or raw DOM selectors.

## Conversation strategy

Use a dedicated ChatGPT conversation per batch by default.

Benefits:

- Reduces cross-project context contamination.
- Makes batch recovery and diagnostics easier.
- Keeps related task history together.
- Avoids creating a new conversation for every beat.

Every prompt must remain self-contained. A beat must not depend on an earlier prompt or assistant response, so it can be retried in a fresh conversation without changing its intended output.

If a conversation becomes unusable, the executor may create a replacement conversation and record the new conversation identity against the batch execution metadata.

## Functional requirements

### Batch intake

- Accept or discover a batch created by VOX.
- Validate protocol version and required fields before claiming work.
- Display the source application, project, batch, task count, and current state.
- Reject unsupported protocol versions with an explicit error.

### Sequential task execution

- Claim work from VOX before execution.
- Process no more than one ChatGPT generation at a time in V1.
- Preserve VOX task order unless VOX explicitly supplies another eligible task.
- Maintain a durable execution checkpoint for the active task.

### Reference handling

- Resolve only the references assigned to the current beat.
- Preserve their declared order.
- Verify reference identity, availability, type, and upload completion.
- Never submit the prompt if any required reference fails.
- Report which reference failed using a stable reference identifier and error code.
- Avoid reusing attachments left over from another task.

### Prompt submission

- Submit the task prompt without semantic rewriting.
- Apply aspect-ratio instructions only as defined by the task payload or protocol.
- Prevent double submission using a durable pre-submit checkpoint, DOM observation, and the task idempotency key.
- Record submission evidence sufficient for recovery and diagnostics.

### Result detection

- Record a baseline of existing assistant messages and images before submission.
- Accept only a new assistant image response attributable to the current submission.
- Never treat a pre-existing image as the result.
- Distinguish an in-progress response from a completed image response.
- Detect safety, usage-limit, verification, network, and generic generation failures without bypassing them.

### Result retrieval and return

- Select the highest-quality generated image representation available through the normal page experience.
- Retrieve and return actual image bytes, MIME type, dimensions when available, and checksum.
- Include protocol version, batch ID, task ID, project ID, beat ID, attempt, and expected output name.
- Treat a temporary ChatGPT URL only as retrieval metadata, not the delivered asset.
- Retry result delivery idempotently after uncertain network outcomes.
- Mark execution complete only after VOX confirms it saved and associated the asset.

### User controls

- Pause after the current safe boundary.
- Resume a paused or interrupted batch.
- Retry a failed task using a new attempt.
- Stop a batch and request cancellation of remaining work.
- Show when manual attention is required.
- Avoid interrupting a prompt submission or result transfer in a way that creates ambiguous state; expose “pausing” or “stopping” while reaching a safe checkpoint.

### Recovery

- Restore the active batch and task after service-worker termination.
- Reconnect content scripts after ChatGPT tab reload.
- Reconcile local checkpoints with VOX before taking action.
- Determine whether a prompt was submitted before attempting a retry.
- Re-observe the conversation for a valid result when submission is known or likely to have occurred.
- Create a new attempt only through VOX when the previous attempt cannot be safely continued.

## Suggested task state model

| State | Meaning |
| --- | --- |
| `queued` | Task exists in VOX and is eligible for future work. |
| `claiming` | Extension is acquiring an execution lease or claim. |
| `uploading_references` | References are being resolved, uploaded, and verified. |
| `submitting` | The extension is committing the prompt submission. |
| `waiting` | Prompt was submitted and the extension is waiting for a new assistant image response. |
| `collecting` | A new result was found and the best image bytes are being retrieved and validated. |
| `returning` | Image bytes are being delivered to VOX and awaiting durable-save confirmation. |
| `completed` | VOX confirmed that the result was saved and associated with the beat. |
| `failed` | The attempt ended with an explicit failure and diagnostic code. |
| `paused` | Execution is durably paused at a safe boundary. |
| `canceled` | Work was canceled and will not continue without a new task or attempt. |

State transitions must be reported to VOX. Extension-local states may be more granular, but they must map predictably to this shared model.

## VOX API contract

Recommended versioned endpoints:

```text
POST /api/extension/batches
GET  /api/extension/batches/:batchId
POST /api/extension/batches/:batchId/claim
POST /api/extension/tasks/:taskId/progress
POST /api/extension/tasks/:taskId/result
POST /api/extension/tasks/:taskId/fail
POST /api/extension/tasks/:taskId/cancel
```

The protocol identifier for the initial contract is:

```text
vox-chatgpt/1
```

All requests and responses should include the protocol version. The server should reject incompatible major versions explicitly rather than interpreting them loosely.

### Minimum batch data

- Protocol version.
- Batch ID.
- Project ID.
- Source application identity.
- Ordered task IDs.
- Creation timestamp.
- Desired conversation strategy.
- Batch status and revision.

### Minimum task data

- Task ID.
- Batch ID.
- Project ID.
- Beat ID.
- Exact prompt.
- Prompt hash.
- Aspect ratio.
- Ordered reference descriptors.
- Expected output name.
- Attempt number.
- Idempotency key.
- Current state and revision.

### Idempotency

The task idempotency key should be derived from:

```text
project ID + beat ID + prompt hash + attempt
```

VOX should enforce idempotent result ingestion. Repeating a result request with the same key and checksum must return the existing successful confirmation. A conflicting checksum for the same key must return an explicit conflict error.

Claiming should use a renewable lease or comparable mechanism so work can be recovered when an extension disappears. Progress updates should include the task revision or lease token to prevent stale executors from overwriting newer state.

### Result submission

The result endpoint must accept image bytes, preferably as a streaming or multipart upload, plus:

- Protocol version.
- Idempotency key.
- Batch, task, project, and beat IDs.
- Attempt.
- Expected output name.
- MIME type.
- Byte length.
- Content checksum.
- Image dimensions when available.
- Executor and diagnostic metadata.

A successful response must mean that VOX durably saved the asset and associated it with the requested beat. Merely accepting an asynchronous upload is not enough unless VOX returns a later confirmation that the extension can reconcile.

## Extension architecture

### Components

1. **Application adapters**
   - Discover and communicate with a source application.
   - Map external payloads to the internal batch/task model.
   - Initial adapter: VOX using `vox-chatgpt/1`.

2. **Background orchestrator**
   - Runs in the Manifest V3 service worker.
   - Reconciles server state, claims tasks, advances the state machine, and schedules recovery.
   - Persists checkpoints before and after side effects.

3. **ChatGPT tab manager**
   - Finds, opens, and restores the correct ChatGPT tab and batch conversation.
   - Ensures that commands target the intended tab and document.

4. **ChatGPT page adapter**
   - Runs through a content script.
   - Exposes semantic operations such as recording a baseline, uploading references, submitting once, observing a new result, and retrieving image candidates.
   - Does not contain VOX-specific logic.

5. **Selector and label registry**
   - Stores selectors, accessibility roles, visible labels, and fallback strategies outside orchestration logic.
   - Supports diagnostics and targeted updates when the ChatGPT UI changes.

6. **Durable local store**
   - Stores connection settings, active execution identifiers, task checkpoints, tab/conversation identity, claims, submission evidence, and bounded diagnostic logs.
   - Is reconciled against VOX and never treated as authoritative project state.

7. **Extension UI**
   - Provides batch status, active task, progress, pause, resume, retry, stop, connection status, and diagnostics.

### Internal adapter boundaries

Suggested interfaces:

```text
ApplicationAdapter
  connect()
  getBatch()
  claimNextTask()
  reportProgress()
  returnResult()
  reportFailure()
  cancelTask()

GenerationExecutor
  ensureSession()
  recordBaseline()
  uploadReferences()
  verifyReferences()
  submitPromptOnce()
  waitForNewResult()
  collectBestImage()

ExecutionStore
  loadCheckpoint()
  saveCheckpoint()
  appendDiagnostic()
  clearCompletedExecution()
```

## Manifest V3 resilience

The design must never depend on an in-memory loop remaining alive.

- Persist state before every externally visible side effect.
- Persist evidence immediately after the side effect is observed.
- Drive work as resumable state-machine steps.
- Use Chrome alarms, messages, tab events, and server reconciliation to wake the orchestrator.
- Make content-script commands request/response based and safe to retry.
- Store bounded structured diagnostics in `chrome.storage.local`.
- Keep sensitive credentials minimal; prefer explicit local connection configuration and scoped tokens.
- On startup, reconcile any non-terminal local execution with VOX before continuing.

## Submission safety

Prompt submission is the most duplication-sensitive action.

Before submission, the extension must persist:

- Task and attempt identity.
- Idempotency key.
- Prompt hash.
- Conversation and tab identity.
- Message/image baseline.
- Verified ordered attachment evidence.
- A `submission_pending` checkpoint.

After interacting with the submit control, it must observe evidence that the user message entered the conversation and persist that evidence before progressing. If the worker terminates during this window, recovery must inspect the DOM and conversation before deciding whether another submission is safe.

If submission status remains ambiguous, the extension must not guess. It should report a recoverable ambiguity and require a server-authorized new attempt or manual review.

## Error model

Errors should be stable, machine-readable, and accompanied by human-readable context.

Suggested codes:

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_PROTOCOL` | The integration protocol version is not supported. |
| `VOX_UNREACHABLE` | The VOX API could not be reached. |
| `AUTH_REQUIRED` | ChatGPT or VOX requires user authentication. |
| `VERIFICATION_REQUIRED` | ChatGPT requires a user verification step. |
| `USAGE_LIMIT_REACHED` | ChatGPT reports a usage or rate limit. |
| `CLAIM_CONFLICT` | Another executor owns or advanced the task. |
| `REFERENCE_FETCH_FAILED` | A required reference could not be retrieved. |
| `REFERENCE_UPLOAD_FAILED` | A required reference did not upload successfully. |
| `REFERENCE_VERIFICATION_FAILED` | Uploaded references could not be verified exactly. |
| `CHATGPT_UI_UNSUPPORTED` | Required ChatGPT controls could not be identified. |
| `SUBMISSION_AMBIGUOUS` | It is unsafe to decide whether the prompt was submitted. |
| `SUBMISSION_REJECTED` | ChatGPT rejected the prompt submission. |
| `GENERATION_FAILED` | ChatGPT reported or produced a generation failure. |
| `GENERATION_TIMEOUT` | No qualifying new result appeared within the allowed period. |
| `RESULT_NOT_NEW` | Candidate output existed before the current submission baseline. |
| `RESULT_FETCH_FAILED` | The generated image bytes could not be retrieved. |
| `RESULT_INVALID` | Retrieved bytes were not a valid supported image. |
| `RESULT_CONFLICT` | VOX found conflicting content for the same idempotency key. |
| `RESULT_SAVE_UNCONFIRMED` | VOX did not confirm durable save and beat association. |
| `TASK_CANCELED` | The user or source application canceled the task. |
| `INTERNAL_ERROR` | An unexpected extension failure occurred. |

Errors should be classified as retryable, user-action-required, or terminal for the current attempt.

## Diagnostics and privacy

Diagnostic records should include:

- Timestamp and extension version.
- Protocol version.
- Batch, task, beat, and attempt IDs.
- State transition.
- Tab and conversation identifiers where safe.
- Selector strategy used.
- Counts and stable fingerprints of baseline messages, images, and attachments.
- Error code and sanitized context.
- Network response status and correlation IDs.

Diagnostics should not store raw authentication data. Full prompt text, image bytes, and reference URLs should be excluded by default or redacted; hashes and stable IDs are preferred. Logs must be bounded and exportable by the user for troubleshooting.

## Security constraints

- Request the minimum Chrome permissions required.
- Restrict host permissions to supported application origins and ChatGPT origins.
- Validate message origin, sender tab, protocol version, and payload schema.
- Do not accept arbitrary page instructions as privileged extension commands.
- Protect VOX connection tokens using extension-local storage and narrow server scopes.
- Validate returned content type, size, and checksum before delivery.
- Do not execute remote code.
- Do not bypass login, verification, safety systems, or usage limits.

## Testing strategy

### Unit tests

- State-machine transitions and recovery.
- Idempotency-key generation.
- Protocol validation and version rejection.
- Reference ordering and verification.
- Baseline and new-result classification.
- Error classification and retry policy.
- Result checksum and metadata generation.

### Fake ChatGPT DOM tests

Build deterministic fixtures for:

- Empty and pre-populated conversations.
- Existing assistant images before submission.
- Multiple ordered attachment uploads.
- Failed or stuck attachment uploads.
- Streaming assistant responses.
- Successful new image responses.
- Multiple image candidates and quality variants.
- Generation failures and safety responses.
- Login, verification, and usage-limit screens.
- DOM label and selector variants.
- Reloads during upload, submission, waiting, and collection.
- User messages that appear after an ambiguous submission.

The automation test suite must prove that an existing image cannot be returned as the current task result and that a prompt is not submitted twice during recovery.

### Integration tests

- VOX batch creation and claiming.
- Lease expiry and executor takeover.
- Progress revisions and stale update rejection.
- Multipart image result ingestion.
- Duplicate result delivery with the same checksum.
- Conflicting result delivery.
- VOX save confirmation and beat attachment.
- Pause, resume, retry, cancel, browser restart, and tab reload.

### Manual compatibility checks

- Supported Chrome versions.
- Logged-in and logged-out ChatGPT states.
- Extension popup and optional side-panel behavior.
- Common ChatGPT UI variants.
- Large references and slow networks.
- User interaction with the ChatGPT tab during execution.

## V1 user experience

The extension UI should show:

- VOX connection status.
- ChatGPT login/session status.
- Active project and batch.
- Completed, remaining, failed, and paused task counts.
- Current beat and execution state.
- Reference upload progress.
- Waiting and result-return progress.
- Pause/resume, retry, and stop controls.
- A concise error message with a diagnostic code.
- A link or action to focus the active ChatGPT tab when manual attention is needed.

The UI must avoid promising background continuity. It should communicate when Chrome or ChatGPT requires the relevant tab to remain available.

## Success criteria

V1 is ready when:

- A VOX batch containing multiple beats can complete sequentially through a logged-in ChatGPT tab.
- Every result is attached to the correct project and beat.
- Reference order is preserved and missing uploads block submission.
- Existing conversation images are never returned as new task results.
- Recovery does not duplicate prompt submission in tested termination windows.
- VOX receives actual image bytes and confirms durable storage before completion.
- Pause, resume, retry, stop, tab reload, and service-worker restart pass integration tests.
- Failures surface stable error codes and useful sanitized diagnostics.
- ChatGPT restrictions result in a user-action-required or terminal state, not bypass attempts.

## Rollout plan

### Phase 1 — Contract and fake executor

- Finalize `vox-chatgpt/1` schemas and endpoint behavior.
- Implement VOX batch/task ownership and durable result ingestion.
- Implement extension state machine against a fake application adapter and fake ChatGPT DOM.

### Phase 2 — VOX and ChatGPT integration

- Add the VOX adapter.
- Add ChatGPT tab and page adapters.
- Validate sequential execution, baseline detection, uploads, collection, and byte return.

### Phase 3 — Recovery and diagnostics

- Test service-worker termination and browser/tab reload at every state.
- Add lease reconciliation, ambiguity handling, bounded logs, and user-action flows.

### Phase 4 — Limited release

- Release to a small set of VOX users.
- Track task completion, retry, duplication, attachment, and DOM-compatibility failures.
- Update selectors and recovery policies based on observed diagnostics.

### Phase 5 — Adapter expansion

- Stabilize the internal application-adapter interface.
- Document integration requirements for additional applications.
- Add new adapters without coupling them to ChatGPT page automation.

## Key product metrics

- Batch completion rate.
- Task completion rate by attempt.
- Incorrect beat association rate, target: zero.
- Duplicate prompt submission rate, target: zero.
- Stale-image return rate, target: zero.
- Reference upload verification failure rate.
- Recovery success rate after worker or tab interruption.
- Median and percentile task duration.
- VOX result-save confirmation failure rate.
- ChatGPT DOM compatibility failure rate by extension version.

## Open decisions

- The authentication and discovery mechanism between VOX and the extension.
  A proposed decision and approval gates are documented in
  `docs/vox-auth-bridge-contract.md`, with verification in
  `docs/vox-auth-bridge-test-plan.md`.
- Whether VOX is always local, remotely hosted, or both.
- Claim lease duration and renewal cadence.
- Maximum supported reference count, file size, and image formats.
- Timeout policy for generation and result retrieval.
- Whether the extension uses a popup, side panel, or both.
- How conversation identity is captured and restored across ChatGPT URL changes.
- Whether user-approved diagnostic export may include prompt text or screenshots.
- The exact method for retrieving the highest-quality image through supported browser-visible mechanisms.
