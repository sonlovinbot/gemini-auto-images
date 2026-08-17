# Chrome Web Store — Privacy form

## Single purpose description

Help users run image-generation prompts and optional reference images sequentially in their signed-in Gemini tab, then save each completed image locally.

## Permission justifications

### alarms

Keeps the Manifest V3 service worker able to resume a user-started queue and recover persisted task state after the worker is suspended or the side panel reloads.

### downloads

Saves generated images to the user's device and applies the Downloads subfolder selected by the user. The extension also checks download completion so a task is not marked complete prematurely.

### scripting

Runs the extension's packaged image-generation executor in the Gemini page's main world. This is required to interact with Gemini's composer and retrieve authenticated bytes for images generated at the user's request.

### sidePanel

Provides the extension's Create, Queue, Logs, and Settings interface in Chrome's side panel while the user works in Gemini.

### storage

Stores queue state, settings, diagnostic logs, recovery checkpoints, and references locally so user-started batches survive side-panel or service-worker restarts.

### tabs

Finds or opens a Gemini tab, records the active Gemini conversation URL, and returns an interrupted task to the correct conversation without submitting the prompt twice.

## Host permission justifications

### https://gemini.google.com/*

Required to send prompts and optional reference images selected by the user, monitor the resulting Gemini response, retrieve the generated image, and recover an interrupted task in its original Gemini conversation.

### http://localhost/* and http://127.0.0.1/*

Required only for the optional local application bridge. It receives user-initiated image tasks from a web application running on the user's own computer and returns task progress and generated image bytes to that same local application. No arbitrary external websites are accessed through these permissions.

## Remote code

Select: **No, I am not using remote code.**

All executable JavaScript and configuration used by the extension are included in the uploaded package. The extension does not load or execute remote scripts, WebAssembly, or remotely hosted executable code.

## Data usage

Select only: **Website content**.

Explanation, if requested:

The extension handles prompt text, optional reference images, and generated images only to perform image-generation tasks explicitly started by the user. This data is not sold, used for advertising, transferred for credit decisions, or used for purposes unrelated to the extension's single purpose.

Do not select authentication information: the extension uses the browser's existing signed-in Gemini session and does not read or collect passwords, authentication tokens, or verification codes.

## Required certifications

Confirm all applicable limited-use declarations:

- I do not sell or transfer user data to third parties outside the approved use cases.
- I do not use or transfer user data for purposes unrelated to the extension's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

https://gist.github.com/sonlovinbot/a0b64632c57256af4c31cf30a9099f20

## Reviewer test instructions

1. Sign in to Gemini with a reviewer-owned account that has access to image generation.
2. Open https://gemini.google.com/app.
3. Click the Auto Gemini Images extension icon to open its Chrome side panel.
4. In Create, enter a simple image prompt and click Add and run.
5. Open Queue and confirm that the task progresses to completion and exposes the generated image for download.
6. Optionally attach a reference image to a new prompt and confirm that the reference appears in Gemini before the prompt is submitted.

No developer-provided account or credentials are required. The optional localhost integration is not required to test the extension's primary workflow.
