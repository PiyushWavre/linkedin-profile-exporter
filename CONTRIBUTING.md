# Contributing

Contributions are welcome, especially for LinkedIn layout compatibility, accessibility, parser reliability, privacy and security improvements.

## Before opening an issue

1. Test the latest release.
2. Reload the extension from `chrome://extensions` after updating it.
3. Refresh the LinkedIn profile tab.
4. Reproduce the issue with more than one profile when possible.
5. Remove all personal/profile information from screenshots and examples.

Use the GitHub issue forms so reports contain enough information to investigate.

## Local checks

The extension itself has no build step. Repository validation requires Node.js 20+.

```bash
npm run check
```

To build the installable release ZIP:

```bash
npm run package:release
```

## Pull requests

Keep changes generic rather than tied to one person's profile.

Before submitting:

- run `npm run check`;
- keep optional LinkedIn sections optional;
- do not add analytics or remote executable code;
- avoid expanding browser permissions unless the feature clearly requires it;
- update privacy/security documentation when behaviour changes;
- update `CHANGELOG.md` for user-visible changes;
- use synthetic or anonymised data in screenshots and fixtures.

## Security issues

Follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
