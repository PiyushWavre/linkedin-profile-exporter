# Architecture

LinkedIn Profile Exporter is a dependency-free Chrome Manifest V3 extension.

## Runtime flow

1. `popup.js` verifies the active tab is a LinkedIn profile and starts an export job.
2. `service-worker.js` owns job state, navigation, timeouts and phase transitions.
3. `content.js` captures the main profile and supported detail pages in the LinkedIn tab.
4. `sections/` contains section-specific parsers and shared adapters.
5. `core/profile-model.js` normalises and reconciles records without profile-specific hard-coding.
6. `exporter.js` generates escaped Markdown.
7. The service worker returns LinkedIn to the original profile and opens a dedicated export window.
8. `download.js` renders the captured profile summary, retrieves available images, assembles the ZIP and waits for the user to click **Download ZIP**.

## Design principles

- **User initiated:** one export begins from the active profile.
- **Local first:** no application backend or telemetry pipeline.
- **Minimal permissions:** permissions are limited to the current export workflow.
- **Optional sections:** absence of optional LinkedIn data is normal, not an export failure.
- **Bounded waits:** a slow or unfamiliar section should not freeze the whole export indefinitely.
- **Generic parsing:** behaviour must never be mapped to a specific person's profile.
- **Safe output:** captured text is escaped before Markdown output.

## Components

| Component | Responsibility |
| --- | --- |
| `service-worker.js` | Export orchestration, route validation, navigation, cleanup and download lifecycle |
| `content.js` | Visible profile/detail capture and progress UI |
| `core/runtime.js` | URL rules, limits and shared validation |
| `core/profile-model.js` | Normalisation, identity and record reconciliation |
| `core/job-state.js` | Allowed export state transitions |
| `core/capture-data.js` | Compact temporary capture storage |
| `core/images.js` | Bounded image retrieval and JPEG conversion |
| `sections/*` | Supported LinkedIn section parsers |
| `exporter.js` | Section merging and Markdown generation |
| `download.js` | Export-ready UI, ZIP assembly and user-triggered download |
| `zip.js` | Dependency-free ZIP writer |
