# Changelog

All notable public changes to LinkedIn Profile Exporter will be documented here.

## 1.0.0 — 30 September 2026

Initial public release.

### Profile capture

- Export the LinkedIn profile currently open in Chrome.
- Capture supported optional detail sections when data is available and skip sections that are absent.
- Preserve standalone values such as language names even when supporting fields are not present.
- Exclude Featured and Recommendations by design.
- Use bounded waits and conservative fallbacks so one unusual optional section does not block the full export indefinitely.

### Export

- Generate a clean Markdown profile.
- Include profile picture and banner image when they are available and readable.
- Open the finished export in a dedicated app-style window while keeping LinkedIn open in the original tab.
- Start the ZIP download only after the user clicks **Download ZIP**.
- Keep the prepared ZIP available for retry when Chrome cancels or interrupts the save.

### Privacy and security

- Local profile processing and ZIP generation.
- No analytics or telemetry.
- No application backend or automatic cloud upload.
- Manifest V3 with restricted LinkedIn/LinkedIn-image host access.
