# Auto Gemini Images — Privacy Policy

Effective date: August 10, 2026

Auto Gemini Images is a user-operated Chrome extension for sending image-generation prompts and optional reference images to the user's signed-in Gemini session, monitoring the result, and saving generated images.

## Data the extension handles

The extension may handle prompt text, optional reference images, generated images, queue state, settings, diagnostic logs, and the address of the active Gemini conversation. When the user starts a task, prompt text and reference images are sent to `gemini.google.com` through the user's existing signed-in browser session. Generated image bytes may be downloaded to the user's device.

For the optional VOX integration, the extension exchanges task status, prompts, reference images, and generated result bytes with a VOX application running on `localhost` or `127.0.0.1`. This integration is initiated by the user from their local VOX page.

## Storage and retention

Queue state, settings, logs, reference images, and generated results may be stored locally in Chrome extension storage or IndexedDB so interrupted work can resume. Users can clear completed tasks and related local data from the extension interface, or remove all extension data by uninstalling the extension.

## Sharing and third parties

The developer does not sell user data and does not use it for advertising, profiling, credit decisions, or unrelated purposes. Data is sent only to services needed for features the user explicitly invokes: Google Gemini and, when used, the user's VOX application. Use of Gemini is also governed by Google's applicable terms and privacy policy.

## Security and remote code

The extension does not collect Gemini passwords, does not bypass login or verification, and does not execute remotely hosted code. All executable extension code is included in the installed package.

## Contact

Questions or privacy requests can be submitted at https://github.com/sonlovinbot/gemini-auto-images/issues.
