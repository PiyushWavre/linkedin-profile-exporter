# Security policy

## Supported version

Security fixes target the latest public release of LinkedIn Profile Exporter.

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose personal data, authenticated URLs, browser-session information, arbitrary file writes, code execution or another person's information.

Use GitHub private vulnerability reporting after it is enabled for this repository. If that is unavailable, contact **Piyush Wavre** privately through the contact method on the repository owner's GitHub profile.

A useful report includes:

- extension version;
- Chrome version and operating system;
- the affected component;
- minimal reproduction steps using synthetic data where possible;
- expected versus observed behaviour;
- security impact.

Do not include real exported profiles, contact information, cookies, tokens, signed image URLs or other personal information.

## Security design

The extension uses Manifest V3, a restrictive extension-page content security policy, bounded capture operations, validated profile/detail routes, short-lived export state, flat ZIP filenames and local profile processing. Runtime code has no third-party JavaScript dependencies.
