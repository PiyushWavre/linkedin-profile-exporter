# Privacy policy

_Last updated: 30 September 2026_

LinkedIn Profile Exporter is designed as a local-first Chrome extension.

## What the extension processes

When the user explicitly starts an export from a LinkedIn profile, the extension may process information rendered in that browser session, including profile summary fields, supported profile sections, visible Contact info when the user enables that option, and profile/banner image URLs exposed by LinkedIn.

## Where processing happens

Profile parsing, Markdown generation, image conversion and ZIP creation happen locally inside the browser extension.

The project does not include:

- analytics or telemetry;
- an advertising SDK;
- an application backend;
- automatic cloud upload of exported profiles;
- remote executable code.

## Network requests

The extension's host permissions are limited to LinkedIn and LinkedIn's `licdn.com` image hosts. Image requests are used to include the available profile and banner images in the user's local export.

## Temporary browser storage

Chrome session storage is used for short-lived export job state so the Manifest V3 service worker can suspend and resume safely. Expired jobs are cleaned up using browser alarms.

## Downloads

The ZIP is prepared locally and the download begins only after the user clicks **Download ZIP** in the dedicated export window. Chrome controls whether a browser Save dialog is displayed.

## AI tools and other third parties

The extension does not automatically send exports to ChatGPT, Claude or another AI service. If the user manually uploads an exported file to a third-party service, that service's privacy and data-use terms apply.

## Data sharing

The extension does not intentionally transmit exported profile data to Piyush Wavre or to a project analytics service.

## User responsibility

Users should export and use profile information only when they have a legitimate reason and the right to do so. Do not use the project to bypass access restrictions or to collect data in violation of applicable rules or laws.
