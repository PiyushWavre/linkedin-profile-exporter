/* Shared, dependency-free trust boundaries for every extension context. */
(() => {
  'use strict';

  // Known profile sections are all optional from the exporter's point of view.
  // A missing section is normal profile state, not an extraction error. `slug: ''`
  // means the section can be captured from the main profile but should never be
  // probed by inventing a detail URL.
  const SECTION_CONFIG = Object.freeze({
    experience: { slug: 'experience' },
    education: { slug: 'education' },
    certifications: { slug: 'certifications' },
    projects: { slug: 'projects' },
    skills: { slug: 'skills' },
    publications: { slug: 'publications' },
    patents: { slug: 'patents' },
    honors: { slug: 'honors' },
    languages: { slug: 'languages' },
    volunteering: { slug: 'volunteering-experiences' },
    courses: { slug: 'courses' },
    'test-scores': { slug: 'test-scores' },
    organizations: { slug: 'organizations' },
    services: { slug: '' },
    causes: { slug: '' }
  });
  const SECTION_KEYS = Object.freeze(Object.keys(SECTION_CONFIG));
  const SECTION_SLUGS = Object.freeze(
    Object.fromEntries(Object.entries(SECTION_CONFIG).map(([key, value]) => [key, value.slug]))
  );
  const LIMITS = Object.freeze({
    captureBytes: 3 * 1024 * 1024,
    jobBytes: 6 * 1024 * 1024,
    items: 5000,
    imageBytes: 20 * 1024 * 1024,
    imagePixels: 32 * 1024 * 1024,
    imageSide: 8192,
    activeMs: 2 * 60 * 60 * 1000,
    terminalMs: 15 * 60 * 1000
  });

  function parseHttps(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
    } catch {
      return null;
    }
  }

  function canonicalProfileUrl(value) {
    const url = parseHttps(value);
    if (url?.hostname !== 'www.linkedin.com') {
      return '';
    }
    const match = url.pathname.match(/^\/in\/([^/]+)(?:\/|$)/);
    if (!match) {
      return '';
    }
    try {
      const slug = decodeURIComponent(match[1]);
      // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted URLs.
      if (!slug || /[/\\?#\s\u0000-\u001f]/u.test(slug) || /^\.{1,2}$/.test(slug)) {
        return '';
      }
    } catch {
      return '';
    }
    return `https://www.linkedin.com/in/${match[1]}/`;
  }

  function samePageUrl(a, b) {
    try {
      const left = new URL(a),
        right = new URL(b);
      return (
        left.origin === right.origin &&
        left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
      );
    } catch {
      return false;
    }
  }

  function detailLinks(links, profileUrl) {
    const byKey = new Map();
    for (const link of Array.isArray(links) ? links : []) {
      if (!SECTION_KEYS.includes(link?.key)) {
        continue;
      }
      const slug = SECTION_SLUGS[link.key];
      if (!slug) {
        // Main-profile-only sections must never cause speculative navigation.
        continue;
      }
      const url = parseHttps(link.url);
      const expected = `${profileUrl}details/${slug}/`;
      if (
        !url ||
        canonicalProfileUrl(url.href) !== profileUrl ||
        !samePageUrl(url.href, expected)
      ) {
        continue;
      }
      const count = Number(link.expectedCount || link.count || 0);
      byKey.set(link.key, {
        key: link.key,
        slug,
        title: String(link.title || link.key).slice(0, 100),
        url: expected,
        expectedCount: Number.isSafeInteger(count) && count > 0 ? Math.min(count, LIMITS.items) : 0
      });
    }
    return SECTION_KEYS.filter((key) => byKey.has(key)).map((key) => byKey.get(key));
  }

  function allowedImageUrl(value) {
    const url = parseHttps(value);
    return Boolean(
      url && (url.hostname === 'www.linkedin.com' || url.hostname.endsWith('.licdn.com'))
    );
  }

  function safeLink(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) &&
        !url.username &&
        !url.password
        ? url.href
        : '';
    } catch {
      return '';
    }
  }

  function assertCaptureData(data, kind, job) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid capture payload.');
    }
    // Chrome counts session memory, not only UTF-8 bytes. Use a conservative UTF-16 estimate.
    if (JSON.stringify(data).length * 2 > LIMITS.captureBytes) {
      throw new Error('This profile exceeds the capture size limit.');
    }
    const stack = [[data, 0]];
    let nodes = 0;
    while (stack.length) {
      const [value, depth] = stack.pop();
      if (++nodes > 50000 || depth > 20) {
        throw new Error('Capture structure exceeds the safety limit.');
      }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) {
            throw new Error('Invalid capture field.');
          }
          stack.push([child, depth + 1]);
        }
      }
    }
    if (canonicalProfileUrl(data.source_url) !== job.profileUrl) {
      throw new Error('Capture belongs to a different profile.');
    }
    const sections = kind === 'profile' ? data.sections : [data];
    if (!Array.isArray(sections) || sections.length > SECTION_KEYS.length) {
      throw new Error('Invalid capture sections.');
    }
    if (
      kind === 'profile' &&
      (!data.top || typeof data.top.name !== 'string' || !data.top.name.trim())
    ) {
      throw new Error('The profile name could not be read. Refresh the profile and try again.');
    }
    for (const section of sections) {
      if (
        !SECTION_KEYS.includes(section?.key) ||
        !Array.isArray(section.items) ||
        section.items.length > LIMITS.items
      ) {
        throw new Error('Invalid section records.');
      }
      if (section.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error('Invalid profile record.');
      }
      for (const item of section.items) {
        if (item.canonical) {
          if (
            item.canonical.section_key !== section.key ||
            !item.canonical.fields ||
            Array.isArray(item.canonical.fields)
          ) {
            throw new Error('Invalid canonical section record.');
          }
          if (
            Object.values(item.canonical.fields).some(
              (value) =>
                typeof value !== 'string' &&
                !(Array.isArray(value) && value.every((part) => typeof part === 'string'))
            )
          ) {
            throw new Error('Profile fields must contain text.');
          }
        }
      }
    }
    if (kind === 'detail' && data.key !== job.queue?.[job.currentIndex]?.key) {
      throw new Error('Unexpected detail section.');
    }
  }

  globalThis.LinkedInRuntime = Object.freeze({
    SECTION_KEYS,
    SECTION_SLUGS,
    LIMITS,
    parseHttps,
    canonicalProfileUrl,
    samePageUrl,
    detailLinks,
    allowedImageUrl,
    safeLink,
    assertCaptureData
  });
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.LinkedInRuntime;
  }
})();
