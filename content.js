(() => {
  'use strict';
  if (window.__linkedinProfileExporterLoadedV175) {
    return;
  }
  window.__linkedinProfileExporterLoadedV175 = true;

  const VERSION = chrome.runtime.getManifest().version;
  const runtime = globalThis.LinkedInRuntime;
  let captureRun = null;
  function assertCaptureActive() {
    if (
      captureRun &&
      (captureRun.cancelled || runtime.canonicalProfileUrl(location.href) !== captureRun.profileUrl)
    ) {
      throw new Error('Capture cancelled or the profile changed.');
    }
  }
  const sleep = async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    assertCaptureActive();
  };
  async function sendCaptureMessage(message) {
    let timer;
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({ ...message, pageUrl: location.href }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'The extension did not acknowledge capture within 15 seconds. Refresh the profile and retry.'
                )
              ),
            15000
          );
        })
      ]);
      if (!response?.ok) {
        throw new Error(
          response?.error || 'The extension rejected this capture. Refresh the profile and retry.'
        );
      }
      return response;
    } catch (error) {
      error.code = 'CAPTURE_HANDOFF_FAILED';
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const PROFILE_CAPTURE_BUDGET_MS = 44000;
  const DETAIL_CAPTURE_BUDGET_MS = 120000;
  let captureDeadline = 0;
  let renderedTextLedger = [];
  let renderedTextSize = 0;
  let renderedEvidenceKeys = new Set();

  function resetCaptureLedger(budgetMs = DETAIL_CAPTURE_BUDGET_MS) {
    renderedTextLedger = [];
    renderedTextSize = 0;
    renderedEvidenceKeys = new Set();
    captureDeadline = Date.now() + Math.max(10000, Number(budgetMs || DETAIL_CAPTURE_BUDGET_MS));
  }

  function captureBudgetExpired() {
    assertCaptureActive();
    return Boolean(captureDeadline && Date.now() >= captureDeadline);
  }

  function addRenderedText(element) {
    if (!element) {
      return;
    }
    const text = String(element.innerText || element.textContent || '');
    const scrollTop = Math.round(
      Number(document.scrollingElement?.scrollTop || window.scrollY || 0)
    );
    const scrollBucket = Math.max(0, Math.round(scrollTop / 240));
    const lines = text
      .split(/\n+/)
      .map((line) => norm(line))
      .filter((line) => line && line.length <= 1200);
    // Deduplicate entire viewport snapshots. Repeated field values inside a
    // snapshot (for example two language proficiencies) carry real meaning.
    const key = `${scrollBucket}|${lines.join('\n')}`;
    if (renderedEvidenceKeys.has(key) || renderedTextSize >= 600000) {
      return;
    }
    renderedEvidenceKeys.add(key);
    for (const line of lines) {
      if (renderedTextLedger.length >= 6000 || renderedTextSize + line.length > 600000) {
        break;
      }
      renderedTextLedger.push({ text: line, scroll_top: scrollTop, scroll_bucket: scrollBucket });
      renderedTextSize += line.length + 1;
    }
  }

  function renderedTextSnapshot() {
    return renderedTextLedger.map((entry) => entry.text).join('\n');
  }

  async function waitForContentReady(maxMs = 6000, quietMs = 500) {
    const root = document.querySelector('main, [role="main"]') || document.body;
    const started = Date.now();
    let lastMutation = Date.now();
    let observer = null;
    try {
      observer = new MutationObserver(() => {
        lastMutation = Date.now();
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      while (Date.now() - started < maxMs) {
        const text = norm(root.innerText || root.textContent || '');
        if (text.length > 120 && Date.now() - lastMutation >= quietMs) {
          break;
        }
        await sleep(120);
      }
    } catch (_) {
      await sleep(quietMs);
    } finally {
      try {
        observer?.disconnect();
      } catch {
        /* Optional DOM probe or tab navigation can fail during capture. */
      }
    }
  }

  function linkedInErrorHeading() {
    return norm(document.querySelector('main h1, main h2, [role="alert"]')?.textContent || '');
  }

  function isLinkedInMissingPage() {
    return /^(?:this page doesn[’']?t exist|page not found)[.!]?$/i.test(linkedInErrorHeading());
  }

  function isLinkedInErrorPage() {
    return /^(?:this page doesn[’']?t exist|page not found|something went wrong|try again later)[.!]?$/i.test(
      linkedInErrorHeading()
    );
  }

  function isLinkedInAccessGate() {
    if (/^\/(?:checkpoint|authwall|login|signup|uas\/login)(?:\/|$)/i.test(location.pathname)) {
      return true;
    }
    return Boolean(
      document.querySelector(
        'form[action*="/login"] input[type="password"], form[action*="/checkpoint"]'
      )
    );
  }

  function capturePreflight() {
    const root = document.querySelector('main#workspace, main, [role="main"]');
    const scrollNode = findScrollContainer(root);
    const metrics = scrollMetrics(scrollNode);
    const documentTop = Math.round(
      Number(document.scrollingElement?.scrollTop || window.scrollY || 0)
    );
    const profilePath = /^\/in\/[^/]+\/?$/i.test(location.pathname);
    const name = norm(parseTopCard()?.name || '');
    return {
      ok: profilePath && !isLinkedInErrorPage() && !isLinkedInAccessGate() && Boolean(root),
      profilePath,
      errorPage: isLinkedInErrorPage(),
      accessGate: isLinkedInAccessGate(),
      scrollTop: Math.max(documentTop, Math.round(metrics.top || 0)),
      nearTop: Math.max(documentTop, Number(metrics.top || 0)) <= 160,
      hasMain: Boolean(root),
      hasProfileName: Boolean(name),
      profileName: name
    };
  }

  function emitCaptureProgress(jobId, payload = {}) {
    if (!jobId) {
      return;
    }
    try {
      chrome.runtime
        .sendMessage({
          type: 'SCRAPE_PROGRESS',
          jobId,
          captureToken: captureRun?.token || '',
          ...payload
        })
        .catch(() => {});
    } catch {
      /* Optional DOM probe or tab navigation can fail during capture. */
    }
  }

  // Profile sections are optional. Capture authored/profile data when LinkedIn
  // actually exposes it, and ignore absent sections without blocking the export.
  // Automatically derived discovery areas such as Interests remain out of scope.
  const SECTION_DEFS = [
    { key: 'about', title: 'About', match: /^about$/i },
    {
      key: 'experience',
      title: 'Experience',
      slug: 'experience',
      match: /^experience(?:\s*\(\d+\))?$/i
    },
    {
      key: 'education',
      title: 'Education',
      slug: 'education',
      match: /^education(?:\s*\(\d+\))?$/i
    },
    {
      key: 'certifications',
      title: 'Licenses & certifications',
      slug: 'certifications',
      match: /^(?:licenses?\s*(?:&|and)\s*certifications?|certifications?)(?:\s*\(\d+\))?$/i
    },
    { key: 'projects', title: 'Projects', slug: 'projects', match: /^projects?(?:\s*\(\d+\))?$/i },
    { key: 'skills', title: 'Skills', slug: 'skills', match: /^skills?(?:\s*\(\d+\))?$/i },
    {
      key: 'publications',
      title: 'Publications',
      slug: 'publications',
      match: /^publications?(?:\s*\(\d+\))?$/i
    },
    { key: 'patents', title: 'Patents', slug: 'patents', match: /^patents?(?:\s*\(\d+\))?$/i },
    {
      key: 'honors',
      title: 'Honors & awards',
      slug: 'honors',
      match: /^(?:honors?|honours?)\s*(?:&|and)\s*awards?(?:\s*\(\d+\))?$/i
    },
    {
      key: 'languages',
      title: 'Languages',
      slug: 'languages',
      match: /^languages?(?:\s*\(\d+\))?$/i
    },
    {
      key: 'volunteering',
      title: 'Volunteering',
      slug: 'volunteering-experiences',
      match: /^(?:volunteer(?:ing)?(?:\s+experience)?|volunteering)(?:\s*\(\d+\))?$/i
    },
    { key: 'courses', title: 'Courses', slug: 'courses', match: /^courses?(?:\s*\(\d+\))?$/i },
    {
      key: 'test-scores',
      title: 'Test scores',
      slug: 'test-scores',
      match: /^test scores?(?:\s*\(\d+\))?$/i
    },
    {
      key: 'organizations',
      title: 'Organizations',
      slug: 'organizations',
      match: /^organi[sz]ations?(?:\s*\(\d+\))?$/i
    },
    { key: 'services', title: 'Services', slug: '', match: /^services?(?:\s*\(\d+\))?$/i },
    { key: 'causes', title: 'Causes', slug: '', match: /^causes?(?:\s*\(\d+\))?$/i }
  ];

  const IMPORTANT_SECTION_KEYS = new Set(SECTION_DEFS.map((def) => def.key));

  const ANCHOR_KEY_MAP = {
    Experience: 'experience',
    Education: 'education',
    Certifications: 'certifications',
    Project: 'projects',
    Projects: 'projects',
    Skills: 'skills',
    Publications: 'publications',
    Patents: 'patents',
    Organizations: 'organizations',
    Services: 'services',
    Causes: 'causes',
    VolunteerExperience: 'volunteering',
    Courses: 'courses',
    Honors: 'honors',
    TestScores: 'test-scores',
    Languages: 'languages'
  };

  const DETAIL_ROOT_SUFFIX = {
    experience: ['ExperienceDetailsSection', 'ExperienceDetails', 'ExperienceDetailsLevel'],
    education: ['EducationDetailsSection', 'EducationDetails', 'EducationDetailsLevel'],
    certifications: [
      'CertificationDetailsLevel',
      'CertificationsDetails',
      'CertificationDetails',
      'CertificationsDetailsSection'
    ],
    projects: ['ProjectsDetails', 'ProjectDetails', 'ProjectsDetailsSection'],
    skills: ['SkillDetails', 'SkillsDetails', 'SkillDetailsSection'],
    publications: ['PublicationDetailsSection', 'PublicationsDetails', 'PublicationDetails'],
    patents: ['PatentsDetails', 'PatentDetails', 'PatentsDetailsSection'],
    honors: ['HonorsDetails', 'HonorsDetailsSection', 'HonorDetails', 'HonoursDetails'],
    languages: ['LanguageDetails', 'LanguagesDetails', 'LanguagesDetailsSection'],
    volunteering: [
      'VolunteerExperienceDetails',
      'VolunteerExperienceDetailsSection',
      'VolunteeringDetails'
    ],
    courses: ['CoursesDetails', 'CourseDetails', 'CoursesDetailsSection', 'CourseDetailsSection'],
    'test-scores': [
      'TestScoresDetails',
      'TestScoreDetails',
      'TestScoresDetailsSection',
      'TestScoreDetailsSection'
    ],
    organizations: ['OrganizationsDetails', 'OrganizationDetails', 'OrganizationsDetailsSection']
  };

  const EXCLUDED_SECTION_PATTERNS = [
    /^analytics$/i,
    /^activity$/i,
    /^featured$/i,
    /^recommendations?(?:\s+(?:received|given))?$/i,
    /^highlights$/i,
    /^resources$/i,
    /^suggested for you$/i,
    /^more profiles for you$/i,
    /^explore premium profiles$/i,
    /^people you may know$/i,
    /^who your viewers also viewed$/i,
    /^you might like$/i,
    /^pages for you$/i,
    /^connected apps$/i,
    /^ad options$/i,
    /^profile language$/i,
    /^public profile(?:\s*&| and)?\s*url$/i,
    /^recommendation transparency$/i,
    /^questions\??$/i
  ];

  const UI_LINE_PATTERNS = [
    /^show all(?:\s+\d+)?(?:\s+.*)?$/i,
    /^show credential$/i,
    /^see credential$/i,
    /^show project$/i,
    /^show publication$/i,
    /^show patent$/i,
    /^see more$/i,
    /^…\s*more$/i,
    /^show more$/i,
    /^edit$/i,
    /^add$/i,
    /^endorse$/i,
    /^follow$/i,
    /^connect$/i,
    /^message$/i,
    /^send$/i,
    /^save$/i,
    /^request proposal$/i,
    /^back$/i,
    /^close$/i,
    /^ad options$/i,
    /^why am i seeing this ad\??$/i,
    /^manage your ad preferences$/i,
    /^hide or report this ad$/i,
    /^report this ad$/i,
    /^submit$/i,
    /^about$/i,
    /^accessibility$/i,
    /^talent solutions$/i,
    /^community guidelines$/i,
    /^careers$/i,
    /^marketing solutions$/i,
    /^privacy\s*&\s*terms$/i,
    /^ad choices$/i,
    /^advertising$/i,
    /^sales solutions$/i,
    /^mobile$/i,
    /^small business$/i,
    /^safety center$/i,
    /^questions\??$/i,
    /^visit our help center\.?$/i,
    /^manage your account and privacy$/i,
    /^go to your settings\.?$/i,
    /^recommendation transparency$/i,
    /^learn more about recommended content\.?$/i,
    /^select language$/i
  ];

  function norm(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\r/g, '')
      .replace(/\n[ \t]+/g, '\n')
      .trim();
  }

  function unique(items) {
    const seen = new Set();
    const out = [];
    for (const raw of items || []) {
      const value = norm(raw);
      if (!value) {
        continue;
      }
      const key = value.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(value);
    }
    return out;
  }

  function isUiLine(line) {
    const text = norm(line);
    return !text || UI_LINE_PATTERNS.some((rx) => rx.test(text));
  }

  function profileRootUrl() {
    const url = new URL(location.href);
    const match = url.pathname.match(/^\/in\/[^/]+/i);
    return match ? `${url.origin}${match[0]}/` : `${url.origin}${url.pathname}`;
  }

  function absoluteUrl(href) {
    try {
      return new URL(href, location.href).href;
    } catch (_) {
      return href || '';
    }
  }

  function unwrapLinkedInRedirect(href) {
    const absolute = absoluteUrl(href);
    try {
      const url = new URL(absolute);
      const redirected = url.searchParams.get('url');
      if (redirected && url.hostname === 'www.linkedin.com') {
        return runtime.safeLink(redirected);
      }
      return url.href;
    } catch (_) {
      return absolute;
    }
  }

  function isUsefulLink(href) {
    if (!href) {
      return false;
    }
    const url = absoluteUrl(href);
    if (!runtime.safeLink(url)) {
      return false;
    }
    if (/\/edit(?:\/|$)/i.test(url) || /\/edit\/forms\//i.test(url)) {
      return false;
    }
    return true;
  }

  function linksFrom(element) {
    if (!element) {
      return [];
    }
    const seen = new Set();
    const links = [];
    for (const a of element.querySelectorAll('a[href]')) {
      const href = unwrapLinkedInRedirect(a.getAttribute('href'));
      if (!isUsefulLink(href) || seen.has(href)) {
        continue;
      }
      seen.add(href);
      links.push({ text: norm(a.innerText || a.getAttribute('aria-label') || ''), url: href });
    }
    return links;
  }

  function cleanCloneText(element) {
    if (!element) {
      return '';
    }
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, svg').forEach((n) => n.remove());
    return norm(clone.innerText || clone.textContent || '');
  }

  function textLines(element, { keepUi = false } = {}) {
    if (!element) {
      return [];
    }
    const text = cleanCloneText(element);
    return unique(
      text
        .split(/\n+/)
        .map(norm)
        .filter((line) => keepUi || !isUiLine(line))
    );
  }

  function parseLocation(locationText) {
    const parts = norm(locationText)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) {
      return { city: '', region: '', country: '' };
    }
    if (parts.length === 1) {
      return { city: '', region: '', country: parts[0] };
    }
    if (parts.length === 2) {
      return { city: parts[0], region: '', country: parts[1] };
    }
    return { city: parts[0], region: parts.slice(1, -1).join(', '), country: parts.at(-1) };
  }

  function stripCountFromTitle(title) {
    return norm(title)
      .replace(/\s*\(\d+\)\s*$/, '')
      .trim();
  }

  function countFromTitle(title) {
    const m = norm(title).match(/\((\d+)\)\s*$/);
    return m ? Number(m[1]) : null;
  }

  function stableSectionKey(value) {
    return (
      stripCountFromTitle(value)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'section'
    );
  }

  function titleFromSlug(slug) {
    return norm(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function sectionDefFromTitle(title) {
    const clean = norm(title).replace(/\s+/g, ' ');
    return SECTION_DEFS.find((def) => def.match.test(clean)) || null;
  }

  function defByKey(key) {
    return SECTION_DEFS.find((d) => d.key === key) || null;
  }
  function defBySlug(slug) {
    return SECTION_DEFS.find((d) => d.slug === slug) || null;
  }

  function isExcludedSectionTitle(title) {
    const clean = stripCountFromTitle(title);
    return !clean || EXCLUDED_SECTION_PATTERNS.some((rx) => rx.test(clean));
  }

  function dynamicSectionDef(title, slug = '') {
    const cleanTitle = stripCountFromTitle(title) || titleFromSlug(slug);
    if (!cleanTitle || isExcludedSectionTitle(cleanTitle)) {
      return null;
    }
    return { key: stableSectionKey(cleanTitle), title: cleanTitle, slug, generic: true };
  }

  function sectionDefOrDynamic(title, slug = '') {
    return sectionDefFromTitle(title) || dynamicSectionDef(title, slug);
  }

  function ownHeadings(section) {
    return Array.from(section.querySelectorAll('h2, h3'))
      .filter((h) => h.closest('section') === section)
      .map((h) => ({ node: h, text: norm(h.innerText || h.textContent || '') }))
      .filter((x) => x.text);
  }

  function sectionDefFromAnchor(section) {
    const anchors = Array.from(
      section.querySelectorAll('[componentkey*="ProfileNullStateCardAnchor_"]')
    ).filter(
      (el) =>
        el.closest('section') === section || el.closest('section')?.contains(section) === false
    );
    for (const el of anchors) {
      const value = String(el.getAttribute('componentkey') || '');
      const match = value.match(/ProfileNullStateCardAnchor_([A-Za-z]+)/);
      if (!match) {
        continue;
      }
      const key = ANCHOR_KEY_MAP[match[1]];
      if (key) {
        return defByKey(key);
      }
    }
    return null;
  }

  function hasNullStateAnchor(section, key = '') {
    const anchors = Array.from(
      section?.querySelectorAll?.('[componentkey*="ProfileNullStateCardAnchor_"]') || []
    );
    if (!anchors.length) {
      return false;
    }
    if (!key) {
      return true;
    }
    return anchors.some((el) => {
      const match = String(el.getAttribute('componentkey') || '').match(
        /ProfileNullStateCardAnchor_([A-Za-z]+)/
      );
      return Boolean(match && ANCHOR_KEY_MAP[match[1]] === key);
    });
  }

  function hasStructuredProfileRecordEvidence(section) {
    return Boolean(
      section?.querySelector?.(
        [
          '[componentkey^="entity-collection-item"]',
          '[data-view-name="profile-component-entity"]',
          '[data-view-name*="profile-component-entity"]',
          'li[class*="pvs-list__paged-list-item"]',
          '[componentkey^="com.linkedin.sdui.profile.skill("]'
        ].join(',')
      )
    );
  }

  function classifySection(section) {
    // The current LinkedIn SDUI page wraps the whole profile column in one
    // aria-label="Primary content" section. It is a composite wrapper, not a
    // profile section, so never parse it as one record.
    if (section.getAttribute('aria-label') === 'Primary content') {
      return null;
    }

    // Nested top-card sections can look like ordinary sections because the
    // person's name is rendered as an h2. Do not export the profile header as
    // an arbitrary generic section.
    if (
      section.querySelector('[componentkey^="ProfileVerificationTriggerRef-"]') ||
      section.querySelector('a[href*="/overlay/contact-info/"]')
    ) {
      return null;
    }

    const own = ownHeadings(section);
    const heading = own[0]?.text || '';
    const anchorDef = sectionDefFromAnchor(section);
    const def = anchorDef || sectionDefOrDynamic(heading);
    if (!def || !IMPORTANT_SECTION_KEYS.has(def.key)) {
      return null;
    }
    return { def, heading: heading || def.title };
  }

  function findTopCard() {
    const verification = document.querySelector(
      'main [componentkey^="ProfileVerificationTriggerRef-"]'
    );
    if (verification) {
      return (
        verification.closest('section') ||
        verification.closest('div') ||
        document.querySelector('main')
      );
    }
    const profilePhoto = document.querySelector('main [aria-label="Profile photo" i]');
    if (profilePhoto) {
      return profilePhoto.closest('section') || document.querySelector('main');
    }
    const sections = Array.from(document.querySelectorAll('main section'));
    return (
      sections.find((s) => ownHeadings(s).length && !classifySection(s)) ||
      document.querySelector('main') ||
      document.body
    );
  }

  function bestImgUrl(img) {
    if (!img) {
      return '';
    }
    const candidates = [];
    for (const part of String(img.getAttribute('srcset') || '').split(',')) {
      const bits = part.trim().split(/\s+/);
      const url = bits[0];
      const descriptor = bits[1] || '';
      let score = 0;
      if (/\d+w$/.test(descriptor)) {
        score = parseInt(descriptor, 10);
      } else if (/\d+(?:\.\d+)?x$/.test(descriptor)) {
        score = Math.round(parseFloat(descriptor) * 1000);
      }
      if (url) {
        candidates.push({ url: absoluteUrl(url), score });
      }
    }
    const direct = img.currentSrc || img.getAttribute('data-delayed-url') || img.src || '';
    if (direct) {
      candidates.push({
        url: absoluteUrl(direct),
        score: Math.max(img.naturalWidth || 0, img.width || 0)
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.url || '';
  }

  function findProfileImages() {
    const card = findTopCard();
    let profile =
      card?.querySelector('[aria-label="Profile photo" i] img, img[src*="profile-displayphoto"]') ||
      null;
    let banner =
      card?.querySelector(
        'img[alt="Cover photo" i], img[alt*="background" i], img[src*="profile-displaybackgroundimage"]'
      ) || null;
    const all = Array.from(card?.querySelectorAll('img') || []);
    if (!profile) {
      profile = all.find((img) => /profile-displayphoto/i.test(`${img.src} ${img.srcset}`)) || null;
    }
    if (!banner) {
      banner =
        all.find((img) => /profile-displaybackgroundimage/i.test(`${img.src} ${img.srcset}`)) ||
        null;
    }
    return {
      profile: { url: bestImgUrl(profile), alt: norm(profile?.alt || '') },
      banner: { url: bestImgUrl(banner), alt: norm(banner?.alt || '') }
    };
  }

  async function clickSeeMore(root = document, { visibleOnly = true } = {}) {
    const buttons = Array.from(root.querySelectorAll('button'));
    let clicked = 0;
    for (const button of buttons) {
      const text = norm(button.innerText || button.textContent || '');
      const aria = norm(button.getAttribute('aria-label') || '');
      // Only inline text expanders; endorsement and navigation controls can
      // contain “see more” while opening a different page or modal.
      const exact = /^(?:…\s*)?(?:see|show) more$/i;
      if (
        !(exact.test(text) || (!text && exact.test(aria))) ||
        (aria && !exact.test(aria) && !/description|text/i.test(aria)) ||
        button.hasAttribute('aria-haspopup') ||
        button.closest('[role="dialog"]')
      ) {
        continue;
      }
      if (button.disabled) {
        continue;
      }
      if (visibleOnly) {
        const rect = button.getBoundingClientRect?.();
        if (
          !rect ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.bottom < 0 ||
          rect.top > (window.innerHeight || 900)
        ) {
          continue;
        }
      }
      try {
        button.click();
        clicked += 1;
        await sleep(80);
      } catch {
        /* Optional DOM probe or tab navigation can fail during capture. */
      }
    }
    return clicked;
  }

  function isDocumentScroller(node) {
    return (
      !node ||
      node === document.scrollingElement ||
      node === document.documentElement ||
      node === document.body
    );
  }

  function scrollMetrics(node) {
    if (isDocumentScroller(node)) {
      const scroller = document.scrollingElement || document.documentElement || document.body;
      const height = Math.max(
        1,
        window.innerHeight || document.documentElement.clientHeight || 800
      );
      const scrollHeight = Math.max(
        scroller?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0
      );
      const top = Number(scroller?.scrollTop || window.scrollY || 0);
      return { top, height, scrollHeight, max: Math.max(0, scrollHeight - height) };
    }
    const height = Math.max(1, node.clientHeight || node.getBoundingClientRect?.().height || 1);
    const scrollHeight = Math.max(height, node.scrollHeight || height);
    const top = Number(node.scrollTop || 0);
    return { top, height, scrollHeight, max: Math.max(0, scrollHeight - height) };
  }

  function describeScrollContainer(node) {
    if (isDocumentScroller(node)) {
      return 'document';
    }
    if (!node) {
      return 'unknown';
    }
    const bits = [String(node.tagName || '').toLowerCase()];
    if (node.id) {
      bits.push(`#${node.id}`);
    }
    const role = node.getAttribute?.('role');
    if (role) {
      bits.push(`[role=${role}]`);
    }
    return bits.join('') || 'element';
  }

  function findScrollContainer(preferredRoot = null) {
    const seen = new Set();
    const candidates = [];
    const add = (node, priority = 0) => {
      if (!node || seen.has(node) || !(node instanceof Element)) {
        return;
      }
      seen.add(node);
      let metrics;
      try {
        metrics = scrollMetrics(node);
      } catch (_) {
        return;
      }
      let rect;
      try {
        rect = node.getBoundingClientRect();
      } catch (_) {
        rect = { width: 0, height: 0 };
      }
      const visibleHeight = isDocumentScroller(node)
        ? window.innerHeight || 800
        : Math.max(0, rect.height || node.clientHeight || 0);
      const visibleWidth = isDocumentScroller(node)
        ? window.innerWidth || 1200
        : Math.max(0, rect.width || node.clientWidth || 0);
      if (metrics.max <= 8 || visibleHeight < 180 || visibleWidth < 280) {
        return;
      }
      let overflowY = '';
      try {
        overflowY = getComputedStyle(node).overflowY || '';
      } catch {
        /* Optional DOM probe or tab navigation can fail during capture. */
      }
      const overflowBonus = /auto|scroll|overlay/i.test(overflowY) ? 50000 : 0;
      const mainBonus = node.matches?.('main, #workspace, [role="main"]') ? 20000 : 0;
      const score =
        metrics.max * 10 +
        Math.min(visibleHeight, window.innerHeight || 900) * 2 +
        overflowBonus +
        mainBonus +
        priority;
      candidates.push({ node, score, metrics });
    };

    const docScroller = document.scrollingElement || document.documentElement || document.body;
    add(docScroller, 15000);
    add(document.documentElement, 12000);
    add(document.body, 10000);
    add(document.querySelector('main#workspace'), 25000);
    add(document.querySelector('main'), 22000);
    add(document.querySelector('[role="main"]'), 22000);

    if (preferredRoot instanceof Element) {
      add(preferredRoot, 30000);
      let parent = preferredRoot.parentElement;
      let depth = 0;
      while (parent && depth < 12) {
        add(parent, 28000 - depth * 900);
        parent = parent.parentElement;
        depth += 1;
      }
    }

    const searchRoot =
      preferredRoot instanceof Element
        ? preferredRoot.closest('main, #workspace, [role="main"]') ||
          document.querySelector('main') ||
          document.body
        : document.querySelector('main') || document.body;
    const nodes = Array.from(searchRoot.querySelectorAll('div, section, main, ul')).slice(0, 3500);
    for (const node of nodes) {
      let m;
      try {
        m = scrollMetrics(node);
      } catch (_) {
        continue;
      }
      if (m.max <= 120 || m.height < Math.max(220, (window.innerHeight || 800) * 0.32)) {
        continue;
      }
      let overflowY = '';
      try {
        overflowY = getComputedStyle(node).overflowY || '';
      } catch {
        /* Optional DOM probe or tab navigation can fail during capture. */
      }
      if (/auto|scroll|overlay/i.test(overflowY) || m.max > 500) {
        add(node, 0);
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.node || docScroller;
  }

  function setScrollTopOn(node, top, behavior = 'auto') {
    const value = Math.max(0, Number(top || 0));
    if (isDocumentScroller(node)) {
      window.scrollTo({ top: value, behavior });
      return;
    }
    try {
      node.scrollTo({ top: value, behavior });
    } catch (_) {
      node.scrollTop = value;
    }
  }

  async function animateScrollToOn(node, top, duration = 300) {
    const target = Math.max(0, Number(top || 0));
    const startMetrics = scrollMetrics(node);
    const start = startMetrics.top;
    const distance = target - start;
    if (
      Math.abs(distance) < 3 ||
      duration <= 0 ||
      matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    ) {
      setScrollTopOn(node, target, 'auto');
      await sleep(60);
      return scrollMetrics(node).top;
    }

    await new Promise((resolve) => {
      const began = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - began) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        setScrollTopOn(node, start + distance * eased, 'auto');
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
    await sleep(80);
    return scrollMetrics(node).top;
  }

  let hudJobState = null;
  let hudCurrentText = 'Preparing visible capture…';
  let activeVisibleCapture = false;

  function hudStatusIcon(status) {
    if (status === 'done') {
      return '✓';
    }
    if (status === 'warn') {
      return '!';
    }
    if (status === 'error') {
      return '×';
    }
    if (status === 'active') {
      return '●';
    }
    return '○';
  }

  function ensureCaptureHud() {
    let hud = document.getElementById('__li_exporter_capture_hud');
    if (hud) {
      return hud;
    }
    hud = document.createElement('aside');
    hud.id = '__li_exporter_capture_hud';
    hud.setAttribute('aria-live', 'polite');
    hud.style.cssText = [
      'position:fixed',
      'top:14px',
      'right:14px',
      'z-index:2147483647',
      'width:360px',
      'max-width:calc(100vw - 28px)',
      'max-height:72vh',
      'overflow:auto',
      'padding:0',
      'border:1px solid rgba(0,0,0,.18)',
      'border-radius:12px',
      'background:rgba(255,255,255,.97)',
      'color:#1f2328',
      'font:13px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.24)',
      'pointer-events:auto',
      'backdrop-filter:blur(8px)'
    ].join(';');
    (document.body || document.documentElement).appendChild(hud);
    renderCaptureHud();
    return hud;
  }

  function renderCaptureHud() {
    const hud = document.getElementById('__li_exporter_capture_hud') || ensureCaptureHud();
    const job = hudJobState || {};
    const tasks = Array.isArray(job.tasks) ? job.tasks : [];
    const terminal = new Set(['done', 'warn', 'error']);
    const completed = tasks.filter((t) => terminal.has(t.status)).length;
    const total = Math.max(1, tasks.length);
    const pct = Math.min(100, Math.round((completed / total) * 100));
    const profileName = job.profileName || 'LinkedIn profile';
    const phase = job.phase || 'preparing';
    const done = phase === 'complete';
    const cancelled = phase === 'cancelled';
    const errored = phase === 'error';

    const taskHtml = tasks
      .map((task) => {
        const status = task.status || 'pending';
        const colour =
          status === 'done'
            ? '#137333'
            : status === 'warn'
              ? '#a15c00'
              : status === 'error'
                ? '#b42318'
                : status === 'active'
                  ? '#0a66c2'
                  : '#6b7280';
        return `<div style="display:grid;grid-template-columns:20px minmax(0,1fr);gap:7px;padding:6px 0;border-top:1px solid #edf0f2;">
        <div style="font-weight:800;color:${colour};">${hudStatusIcon(status)}</div>
        <div style="min-width:0;"><div style="font-weight:650;color:#24292f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(task.title || task.key || 'Section')}</div>
        <div style="margin-top:1px;color:#667085;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(task.detail || status)}</div></div>
      </div>`;
      })
      .join('');

    hud.innerHTML = `<div style="padding:12px 13px 10px;background:#f8fafc;border-bottom:1px solid #e5e7eb;position:sticky;top:0;z-index:2;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="min-width:0;flex:1;"><div style="font-weight:800;font-size:14px;">LinkedIn export · v${VERSION}</div><div style="font-size:11px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(profileName)}</div></div>
        <div style="font-weight:800;color:#0a66c2;">${done ? '100' : pct}%</div>
      </div>
      <div style="height:6px;background:#e7ebef;border-radius:999px;margin-top:8px;overflow:hidden;"><div style="height:100%;width:${done ? 100 : pct}%;background:#0a66c2;border-radius:999px;transition:width .2s ease;"></div></div>
      <div style="margin-top:8px;padding:7px 8px;border-radius:8px;background:#fff;border:1px solid #e5e7eb;color:#344054;font-size:11px;">${escapeHtml(done ? `Export complete${job.filename ? ` · ${job.filename}` : ''}` : cancelled ? 'Export cancelled' : errored ? job.error || 'Export failed' : hudCurrentText)}</div>
    </div>
    <div style="padding:5px 13px 10px;">${taskHtml || '<div style="padding:8px 0;color:#667085;">Preparing section list…</div>'}
      <div style="display:flex;gap:8px;margin-top:8px;">
        ${!done && !cancelled && !errored ? '<button id="__li_exporter_cancel" type="button" style="border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:8px;padding:7px 10px;font:600 12px/1.2 inherit;cursor:pointer;">Cancel export</button>' : ''}
        ${done || cancelled || errored ? '<button id="__li_exporter_hide" type="button" style="border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:8px;padding:7px 10px;font:600 12px/1.2 inherit;cursor:pointer;">Hide</button>' : ''}
      </div>
    </div>`;

    hud.querySelector('#__li_exporter_cancel')?.addEventListener(
      'click',
      () => {
        chrome.runtime.sendMessage({ type: 'CANCEL_SINGLE_TAB_EXPORT' }).catch(() => {});
        hudCurrentText = 'Cancelling export…';
        renderCaptureHud();
      },
      { once: true }
    );
    hud
      .querySelector('#__li_exporter_hide')
      ?.addEventListener('click', () => hud.remove(), { once: true });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );
  }

  function setHudJob(job) {
    if (captureRun && job?.id === captureRun.jobId && ['cancelled', 'error'].includes(job.phase)) {
      captureRun.cancelled = true;
    }
    hudJobState = job || hudJobState;

    // Once capture hands off to the dedicated export window, the LinkedIn tab
    // should be clean again. Completion also needs no acknowledgement here.
    if (['download', 'complete'].includes(hudJobState?.phase)) {
      document.getElementById('__li_exporter_capture_hud')?.remove();
      return;
    }

    ensureCaptureHud();
    renderCaptureHud();
  }

  function updateCaptureHud(text) {
    hudCurrentText = text || 'Capturing LinkedIn profile…';
    if (['download', 'complete'].includes(hudJobState?.phase)) {
      return;
    }
    ensureCaptureHud();
    renderCaptureHud();
  }

  async function restoreHudFromJob() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SINGLE_TAB_JOB' });
      if (response?.job?.phase === 'download') {
        hudJobState = response.job;
        document.getElementById('__li_exporter_capture_hud')?.remove();
      } else if (response?.job && !['complete', 'cancelled', 'error'].includes(response.job.phase)) {
        setHudJob(response.job);
        updateCaptureHud(
          response.job.currentTitle
            ? `${response.job.currentTitle} · waiting for page to settle…`
            : 'Preparing visible capture…'
        );
      } else if (response?.job && ['complete', 'cancelled', 'error'].includes(response.job.phase)) {
        setHudJob(response.job);
      }
    } catch {
      /* Optional DOM probe or tab navigation can fail during capture. */
    }
  }

  function mergeCapturedLinks(primary = [], incoming = []) {
    const out = [];
    const seen = new Set();
    for (const link of [...(primary || []), ...(incoming || [])]) {
      const url = norm(link?.url || '');
      const text = norm(link?.text || '');
      const key = `${url}|${text}`.toLowerCase();
      if ((!url && !text) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(link);
    }
    return out;
  }

  function mergeCapturedItem(sectionKey, primary, incoming) {
    if (!primary) {
      return incoming;
    }
    if (!incoming) {
      return primary;
    }
    const model = globalThis.LinkedInProfileModel;
    const canonical = model?.reconcileCanonical
      ? model.reconcileCanonical(primary.canonical, incoming.canonical)
      : primary.canonical || incoming.canonical;
    const lines = unique(
      [...(primary.lines || []), ...(incoming.lines || [])].map(norm).filter(Boolean)
    );
    const richer =
      String(incoming.text || '').length > String(primary.text || '').length ? incoming : primary;
    return {
      ...primary,
      ...richer,
      lines,
      text: lines.join('\n'),
      title: richer.title || primary.title || incoming.title || '',
      subtitle: richer.subtitle || primary.subtitle || incoming.subtitle || '',
      details: unique(
        [...(primary.details || []), ...(incoming.details || [])].map(norm).filter(Boolean)
      ),
      links: mergeCapturedLinks(primary.links, incoming.links),
      canonical: canonical || primary.canonical || incoming.canonical
    };
  }

  function mergeProfileViewportSections(accumulated = [], incoming = []) {
    const adapters = globalThis.LinkedInSectionAdapters;
    const byKey = new Map((accumulated || []).map((section) => [section.key, section]));
    const order = (accumulated || []).map((section) => section.key);

    for (const section of incoming || []) {
      if (!section?.key) {
        continue;
      }
      const current = byKey.get(section.key);
      if (!current) {
        byKey.set(section.key, {
          ...section,
          items: [...(section.items || [])],
          links: [...(section.links || [])]
        });
        order.push(section.key);
        continue;
      }
      if (section.key === 'about') {
        const currentText = norm(current.raw_text || '');
        const incomingText = norm(section.raw_text || '');
        if (incomingText.length > currentText.length) {
          current.raw_text = section.raw_text;
        }
        current.links = mergeCapturedLinks(current.links, section.links);
        continue;
      }

      const items = [...(current.items || [])];
      const indexByIdentity = new Map();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const identity =
          adapters?.identity?.(section.key, item) ||
          adapters?.signature?.(section.key, item) ||
          norm(item.text || '').toLowerCase();
        if (identity && !indexByIdentity.has(identity)) {
          indexByIdentity.set(identity, i);
        }
      }
      for (const item of section.items || []) {
        const identity =
          adapters?.identity?.(section.key, item) ||
          adapters?.signature?.(section.key, item) ||
          norm(item.text || '').toLowerCase();
        if (identity && indexByIdentity.has(identity)) {
          const index = indexByIdentity.get(identity);
          items[index] = mergeCapturedItem(section.key, items[index], item);
        } else {
          if (identity) {
            indexByIdentity.set(identity, items.length);
          }
          items.push(item);
        }
      }
      current.items = items;
      current.count =
        Math.max(Number(current.count || 0), Number(section.count || 0)) ||
        current.count ||
        section.count ||
        null;
      const currentRaw = norm(current.raw_text || '');
      const incomingRaw = norm(section.raw_text || '');
      if (incomingRaw.length > currentRaw.length) {
        current.raw_text = section.raw_text;
      }
      current.links = mergeCapturedLinks(current.links, section.links);
      current.source_url = current.source_url || section.source_url;
    }
    return order.map((key) => byKey.get(key)).filter(Boolean);
  }

  async function progressiveHydrate({
    restore = false,
    fast = false,
    foreground = false,
    jobId = '',
    onCheckpoint = null
  } = {}) {
    const mainRoot = document.querySelector('main#workspace, main, [role="main"]') || document.body;
    let scrollNode = findScrollContainer(mainRoot);
    const initialTop = scrollMetrics(scrollNode).top;
    let capturedSections = [];
    let lastCheckpoint = 0;
    const checkpoint = async () => {
      if (onCheckpoint && Date.now() - lastCheckpoint >= 3000) {
        lastCheckpoint = Date.now();
        await onCheckpoint(capturedSections);
      }
    };
    window.__liExporterScrollInfo = { container: describeScrollContainer(scrollNode) };

    const captureCurrentViewport = () => {
      addRenderedText(mainRoot);
      capturedSections = mergeProfileViewportSections(capturedSections, parseProfileSections());
      return capturedSections;
    };

    // Single forward traversal: always preserve what is mounted before causing
    // the next scroll. This is especially important on virtualised LinkedIn
    // lists because rows can disappear as soon as the viewport moves.
    captureCurrentViewport();
    if (foreground) {
      updateCaptureHud(`Captured current view · ${describeScrollContainer(scrollNode)}`);
    }
    const initialExpansions = await clickSeeMore(mainRoot || document, { visibleOnly: true });
    if (initialExpansions) {
      await sleep(foreground ? 240 : 100);
      captureCurrentViewport();
    }

    let steps = 0;
    let noMovement = 0;
    let bottomStable = 0;
    const strideRatio = foreground ? 0.82 : 0.72;

    while (steps < (foreground ? 56 : 40)) {
      await checkpoint();
      if (captureBudgetExpired()) {
        break;
      }
      scrollNode = findScrollContainer(mainRoot);
      let metrics = scrollMetrics(scrollNode);
      window.__liExporterScrollInfo = {
        container: describeScrollContainer(scrollNode),
        scrollHeight: metrics.scrollHeight,
        viewport: metrics.height
      };
      captureCurrentViewport();

      const pct =
        metrics.max <= 0 ? 100 : Math.min(100, Math.round((metrics.top / metrics.max) * 100));
      const phase = `Captured current view · profile ${pct}% · ${describeScrollContainer(scrollNode)}`;
      emitCaptureProgress(jobId, {
        event: 'main-scroll',
        phase,
        scrollPercent: pct,
        scrollY: Math.round(metrics.top),
        scrollHeight: metrics.scrollHeight,
        scrollContainer: describeScrollContainer(scrollNode)
      });
      if (foreground) {
        updateCaptureHud(phase);
      }

      const expanded = await clickSeeMore(mainRoot || document, { visibleOnly: true });
      if (expanded) {
        await sleep(foreground ? 240 : 100);
        captureCurrentViewport();
        metrics = scrollMetrics(scrollNode);
      }

      if (metrics.max <= 8) {
        await sleep(foreground ? 850 : 220);
        captureCurrentViewport();
        const redetected = findScrollContainer(mainRoot);
        if (redetected !== scrollNode && scrollMetrics(redetected).max > 8) {
          scrollNode = redetected;
          continue;
        }
        break;
      }

      if (metrics.top >= metrics.max - 6) {
        const beforeHeight = metrics.scrollHeight;
        await sleep(foreground ? 900 : 320);
        const expandedAtBottom = await clickSeeMore(mainRoot || document, { visibleOnly: true });
        if (expandedAtBottom) {
          await sleep(foreground ? 240 : 100);
        }
        captureCurrentViewport();
        const after = scrollMetrics(scrollNode);
        if (after.scrollHeight <= beforeHeight + 8) {
          bottomStable += 1;
        } else {
          bottomStable = 0;
        }
        if (bottomStable >= 2) {
          break;
        }
        steps += 1;
        continue;
      }

      const stride = Math.max(360, Math.round(metrics.height * strideRatio));
      const nextTop = Math.min(metrics.max, metrics.top + stride);
      if (nextTop <= metrics.top + 4) {
        break;
      }
      const beforeTop = metrics.top;
      const actualTop = foreground
        ? await animateScrollToOn(scrollNode, nextTop, 300)
        : (setScrollTopOn(scrollNode, nextTop, 'auto'),
          await sleep(80),
          scrollMetrics(scrollNode).top);
      await sleep(foreground ? 430 : fast ? 80 : 180);

      // Capture the newly mounted viewport immediately after the movement,
      // before any subsequent scroll can cause virtualised rows to unmount.
      captureCurrentViewport();

      if (Math.abs(actualTop - beforeTop) < 3) {
        noMovement += 1;
        const redetected = findScrollContainer(mainRoot);
        if (redetected !== scrollNode && scrollMetrics(redetected).max > 8) {
          scrollNode = redetected;
          noMovement = 0;
          if (foreground) {
            updateCaptureHud(`Switched scroll container · ${describeScrollContainer(scrollNode)}`);
          }
        } else if (noMovement >= 2) {
          emitCaptureProgress(jobId, {
            event: 'main-scroll',
            phase: 'Scroll did not move · ending single forward traversal',
            scrollPercent: pct,
            scrollY: Math.round(actualTop),
            scrollHeight: scrollMetrics(scrollNode).scrollHeight
          });
          break;
        }
      } else {
        noMovement = 0;
      }
      steps += 1;
    }

    if (restore && Math.abs(scrollMetrics(scrollNode).top - initialTop) < 4) {
      // Kept only for backwards-compatible diagnostic callers. Normal visible
      // capture never rewinds the page after the forward traversal.
      setScrollTopOn(scrollNode, initialTop, 'auto');
    }
    if (foreground) {
      updateCaptureHud('Profile scan finished · saving captured records…');
    }
    return capturedSections;
  }

  function metricFromCard(card, word) {
    const rx = new RegExp(`^[\\d,.]+(?:\\+)?(?:\\s*[KMB])?\\s+${word}s?$`, 'i');
    const texts = Array.from(card?.querySelectorAll('a, p, span') || [])
      .map((el) => norm(el.innerText || el.textContent || ''))
      .filter((text) => rx.test(text));
    return unique(texts).sort((a, b) => a.length - b.length)[0] || '';
  }

  function parseTopCard() {
    const card = findTopCard();
    const verification = card?.querySelector('[componentkey^="ProfileVerificationTriggerRef-"]');
    const name = norm(
      verification?.innerText ||
        card?.querySelector('h1')?.textContent ||
        ownHeadings(card || document.createElement('section'))[0]?.text ||
        ''
    );

    const pLines = unique(
      Array.from(card?.querySelectorAll('p') || [])
        .map((p) => norm(p.innerText || p.textContent || ''))
        .filter(Boolean)
    );
    const contactIndex = pLines.findIndex((line) => /^contact info$/i.test(line));
    const preContact = (
      contactIndex >= 0 ? pLines.slice(0, contactIndex) : pLines.slice(0, 8)
    ).filter((line) => line !== name && !/^·(?:\s*\d+(?:st|nd|rd|th))?$/i.test(line));

    const location =
      [...preContact].reverse().find((line) => /,/.test(line) && line.length < 140) || '';
    const pronouns =
      preContact.find((line) => /^(?:he|she|they)(?:\s*\/\s*(?:him|her|them))+$/i.test(line)) || '';
    const headline =
      preContact.find(
        (line) => line !== location && line !== pronouns && line.length > 2 && !/^[·•]$/.test(line)
      ) || '';

    const currentOrganizations = unique(
      Array.from(card?.querySelectorAll('a[href*="/company/"], a[href*="/showcase/"]') || [])
        .map((a) => norm(a.innerText || a.textContent || ''))
        .filter(Boolean)
    );
    const educationSummary = unique(
      Array.from(card?.querySelectorAll('a[href*="/school/"]') || [])
        .map((a) => norm(a.innerText || a.textContent || ''))
        .filter(Boolean)
    );

    if (contactIndex >= 0) {
      const after = pLines
        .slice(contactIndex + 1)
        .filter((line) => line && !/^[·•]$/.test(line))
        .filter((line) => !/^\d[\d,.]*\+?\s+(?:followers?|connections?)$/i.test(line))
        .filter(
          (line) => !/^(?:message|connect|follow|open to|add section|enhance profile)$/i.test(line)
        )
        .filter((line) => !/^online portfolio$/i.test(line))
        .slice(0, 5);

      if (!currentOrganizations.length && after[0]) {
        currentOrganizations.push(after[0]);
      }
      if (!educationSummary.length) {
        const schoolCandidate = after.find((line, index) => {
          if (!line || currentOrganizations.includes(line)) {
            return false;
          }
          return (
            index > 0 ||
            /\b(?:school|university|college|institute|academy|business school|management)\b/i.test(
              line
            )
          );
        });
        if (schoolCandidate) {
          educationSummary.push(schoolCandidate);
        }
      }
    }

    return {
      name,
      pronouns,
      headline,
      location,
      ...parseLocation(location),
      current_organizations: unique(currentOrganizations),
      education_summary: unique(educationSummary),
      followers: metricFromCard(card, 'follower'),
      connections: metricFromCard(card, 'connection'),
      industry: ''
    };
  }

  function topCardWebsites() {
    const card = findTopCard();
    const sites = [];
    const seen = new Set();
    for (const a of card?.querySelectorAll('a[href]') || []) {
      const text = norm(a.innerText || a.textContent || a.getAttribute('aria-label') || '');
      const url = unwrapLinkedInRedirect(a.getAttribute('href') || '');
      if (!url || /linkedin\.com\//i.test(url) || !/^https?:/i.test(url)) {
        continue;
      }
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      sites.push({ label: text || 'Website', url });
    }
    return sites;
  }

  function recordLines(node) {
    if (!node) {
      return [];
    }

    const candidates = [];
    const push = (value) => {
      const text = norm(value);
      if (!text || isUiLine(text) || /^\+\d+$/i.test(text)) {
        return;
      }
      candidates.push(text);
    };

    for (const el of node.querySelectorAll('p, h3, h4, [data-testid="expandable-text-box"]')) {
      if (el.closest('[aria-hidden="true"]')) {
        continue;
      }
      if (el.matches('p, h3, h4') && el.closest('[data-testid="expandable-text-box"]')) {
        continue;
      }
      push(el.innerText || el.textContent || '');
    }

    const semantic = candidates.filter((line, i) => i === 0 || line !== candidates[i - 1]);
    if (semantic.length >= 2) {
      return semantic;
    }

    return textLines(node).filter((line) => !/^\+\d+$/i.test(line));
  }

  function sectionHeadingPattern(def) {
    const key = def?.key || '';
    const aliases = {
      certifications: [
        'Licenses & certifications',
        'Licenses and certifications',
        'Certifications'
      ],
      honors: ['Honors & awards', 'Honours & awards', 'Honors and awards', 'Honours and awards'],
      organizations: ['Organizations', 'Organisations'],
      volunteering: ['Volunteering', 'Volunteer experience'],
      'test-scores': ['Test scores', 'Test score']
    };
    const names = aliases[key] || [def?.title || titleFromSlug(def?.slug || key)];
    const escaped = names
      .filter(Boolean)
      .map((value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^(?:${escaped.join('|')})(?:\\s*\\(\\d+\\))?$`, 'i');
  }

  function sectionAnchorSelector(def) {
    const byKey = {
      experience: 'Experience',
      education: 'Education',
      certifications: 'Certifications',
      projects: 'Project',
      skills: 'Skills',
      publications: 'Publications',
      patents: 'Patents',
      honors: 'Honors',
      languages: 'Languages',
      volunteering: 'VolunteerExperience',
      courses: 'Courses',
      'test-scores': 'TestScores',
      organizations: 'Organizations',
      services: 'Services',
      causes: 'Causes'
    };
    const suffix = byKey[def?.key];
    return suffix ? `[componentkey*="ProfileNullStateCardAnchor_${suffix}"]` : '';
  }

  function directBoundaryStats(parent) {
    const children = Array.from(parent?.children || []);
    const hrs = children.filter((c) => c.tagName === 'HR').length;
    const records = children
      .filter((c) => c.tagName !== 'HR')
      .filter((c) => {
        const text = norm(c.innerText || c.textContent || '');
        return text.length > 2 && text.length < 16000 && !/^show all\b/i.test(text);
      });
    return { hrs, records };
  }

  // Detail pages can contain the requested section plus LinkedIn navigation,
  // sidebar recommendations and footer UI. Parse the smallest section-like
  // ancestor around the matching heading before looking for record cards.
  function narrowSectionScope(container, def) {
    if (!container || !def) {
      return container;
    }
    const anchorSelector = sectionAnchorSelector(def);
    const anchor = anchorSelector ? container.querySelector(anchorSelector) : null;
    const anchoredSection = anchor?.closest('section');
    if (anchoredSection && container.contains(anchoredSection)) {
      return anchoredSection;
    }

    const headingRx = sectionHeadingPattern(def);
    const headings = Array.from(container.querySelectorAll('h1, h2, h3, [role="heading"]'));
    const heading = headings.find((el) =>
      headingRx.test(norm(el.innerText || el.textContent || ''))
    );
    if (!heading) {
      return container;
    }

    let best = null;
    let node = heading.parentElement;
    for (
      let depth = 0;
      node && depth < 9 && container.contains(node);
      depth++, node = node.parentElement
    ) {
      const text = norm(node.innerText || node.textContent || '');
      if (text.length < 8 || text.length > 180000) {
        continue;
      }
      const stats = directBoundaryStats(node);
      const listItems = node.querySelectorAll('[role="listitem"]').length;
      const entities = node.querySelectorAll('[componentkey^="entity-collection-item"]').length;
      const semanticLines = node.querySelectorAll(
        'p, h3, h4, [data-testid="expandable-text-box"]'
      ).length;
      const otherAnchors = Array.from(
        node.querySelectorAll('[componentkey*="ProfileNullStateCardAnchor_"]')
      ).filter((el) => el !== anchor).length;
      const boundaryScore =
        stats.hrs * 20 +
        Math.min(stats.records.length, 20) * 8 +
        Math.min(listItems, 20) * 5 +
        Math.min(entities, 20) * 6 +
        Math.min(semanticLines, 30);
      const score = boundaryScore - otherAnchors * 80 - depth * 2;
      if (boundaryScore > 0 && (!best || score > best.score)) {
        best = { node, score };
      }
      if (otherAnchors > 2) {
        break;
      }
    }
    return best?.node || container;
  }

  function parseRecordNode(node, extra = {}) {
    const lines = recordLines(node);
    return {
      title: lines[0] || '',
      subtitle: lines[1] || '',
      details: lines.slice(2),
      lines,
      text: lines.join('\n'),
      depth: 0,
      has_children: false,
      links: linksFrom(node),
      ...extra
    };
  }

  function findSeparatorGroup(container) {
    let best = null;
    for (const parent of container.querySelectorAll('div, section, ul')) {
      const children = Array.from(parent.children);
      const hrs = children.filter((c) => c.tagName === 'HR').length;
      if (!hrs) {
        continue;
      }
      const records = children
        .filter((c) => c.tagName !== 'HR' && norm(c.innerText || c.textContent || '').length > 3)
        .filter((c) => norm(c.innerText || c.textContent || '').length < 16000)
        .filter((c) => !/^show all\b/i.test(norm(c.innerText || c.textContent || '')));
      if (records.length < 1) {
        continue;
      }
      const depth = (() => {
        let n = parent,
          d = 0;
        while (n && n !== container) {
          d++;
          n = n.parentElement;
        }
        return d;
      })();
      const anchors = parent.querySelectorAll(
        '[componentkey*="ProfileNullStateCardAnchor_"]'
      ).length;
      const footerJunk =
        /(?:select language|privacy\s*&\s*terms|ad choices|recommendation transparency)/i.test(
          norm(parent.innerText || '')
        );
      const score =
        hrs * 100 + records.length * 18 + depth * 3 - anchors * 180 - (footerJunk ? 1000 : 0);
      if (!best || score > best.score) {
        best = { parent, records, score };
      }
    }
    return best;
  }

  function topLevelMatches(container, selector) {
    const nodes = Array.from(container?.querySelectorAll(selector) || []);
    if (!nodes.length) {
      return [];
    }
    const nodeSet = new Set(nodes);
    return nodes.filter((el) => {
      let parent = el.parentElement;
      while (parent && parent !== container) {
        if (nodeSet.has(parent)) {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    });
  }

  function entityRecordNodes(container) {
    // LinkedIn serves several profile DOM families at the same time. Prefer the
    // most specific record marker, then fall back to the current data-view-name
    // family and finally the older PVS list item family. Keeping these selectors
    // ordered avoids treating a whole list wrapper as one giant record.
    const selectors = [
      '[componentkey^="entity-collection-item"]',
      '[data-view-name="profile-component-entity"]',
      '[data-view-name*="profile-component-entity"]',
      'li[class*="pvs-list__paged-list-item"]'
    ];
    for (const selector of selectors) {
      const nodes = topLevelMatches(container, selector).filter((el) => {
        const text = norm(el.innerText || el.textContent || '');
        return text.length > 2 && text.length < 16000 && !/^show all\b/i.test(text);
      });
      if (nodes.length) {
        return nodes;
      }
    }
    return [];
  }

  function recordNodesForSection(container, def) {
    const scope = narrowSectionScope(container, def) || container;
    const entities = entityRecordNodes(scope);
    if (entities.length) {
      return { scope, nodes: entities, source: 'entity-collection-item' };
    }

    const separated = findSeparatorGroup(scope);
    if (separated?.records?.length) {
      return { scope, nodes: separated.records, source: 'separator-siblings' };
    }

    const listItems = Array.from(scope.querySelectorAll('[role="listitem"]'))
      .filter((item) => !item.querySelector('[role="listitem"]'))
      .filter((item) => {
        const text = norm(item.innerText || item.textContent || '');
        return text.length > 2 && text.length < 16000 && !/^show all\b/i.test(text);
      });
    if (listItems.length) {
      return { scope, nodes: listItems, source: 'listitem' };
    }

    const text = norm(scope.innerText || scope.textContent || '');
    const semanticCount = scope.querySelectorAll(
      'p, h3, h4, [data-testid="expandable-text-box"]'
    ).length;
    if (text && text.length < 6500 && semanticCount > 0 && semanticCount < 80) {
      return { scope, nodes: [scope], source: 'bounded-single-record' };
    }
    return { scope, nodes: [], source: 'none' };
  }

  function cleanedSectionLines(lines, def) {
    const headingRx = sectionHeadingPattern(def);
    return unique((lines || []).map(norm).filter(Boolean))
      .filter((line) => !headingRx.test(line))
      .filter((line) => !/^show all\b/i.test(line))
      .filter((line) => !isUiLine(line));
  }

  function itemFromLines(lines, node, extra = {}) {
    const clean = unique((lines || []).map(norm).filter(Boolean));
    return {
      title: clean[0] || '',
      subtitle: clean[1] || '',
      details: clean.slice(2),
      lines: clean,
      text: clean.join('\n'),
      depth: 0,
      has_children: false,
      links: linksFrom(node),
      ...extra
    };
  }

  function genericRecordItems(container, def = null) {
    const found = recordNodesForSection(container, def);
    return found.nodes
      .map((node) => {
        const lines = def ? cleanedSectionLines(recordLines(node), def) : recordLines(node);
        return itemFromLines(lines, node);
      })
      .filter((item) => item.text);
  }

  function languageItems(container, def) {
    const proficiencyRx =
      /^(?:Elementary proficiency|Limited working proficiency|Professional working proficiency|Full professional proficiency|Native or bilingual proficiency)$/i;
    const { scope, nodes } = recordNodesForSection(container, def);
    const out = [];
    const seen = new Set();

    // Deliberately blacklist only LinkedIn UI/control text. Do not use a
    // language-name whitelist: profiles may contain any language name, dialect,
    // signed language or writing system, including non-Latin scripts.
    const plausibleLanguage = (value) => {
      const language = norm(value);
      if (!language || language.length > 110 || proficiencyRx.test(language)) {
        return false;
      }
      if (
        /^(?:Languages?|Show all|Show more|See more|Back|Close|Connect|Message|Follow|Submit|Add)$/i.test(
          language
        )
      ) {
        return false;
      }
      if (/^https?:\/\//i.test(language) || /^(?:19|20)\d{2}$/.test(language)) {
        return false;
      }
      return true;
    };

    const addLanguage = (language, proficiency = '', node = scope) => {
      const lang = norm(language);
      const prof = norm(proficiency);
      if (!plausibleLanguage(lang)) {
        return;
      }
      const sig = lang.toLowerCase();
      if (seen.has(sig)) {
        return;
      }
      seen.add(sig);
      out.push(
        itemFromLines([lang, proficiencyRx.test(prof) ? prof : ''].filter(Boolean), node, {
          kind: 'language'
        })
      );
    };

    for (const node of nodes) {
      const lines = cleanedSectionLines(recordLines(node), def);
      let paired = false;
      for (let i = 1; i < lines.length; i++) {
        if (proficiencyRx.test(lines[i]) && plausibleLanguage(lines[i - 1])) {
          addLanguage(lines[i - 1], lines[i], node);
          paired = true;
        }
      }
      // Some profiles only contain the language name. Preserve that record
      // rather than requiring LinkedIn's optional proficiency field.
      if (!paired && lines.length && plausibleLanguage(lines[0])) {
        addLanguage(lines[0], '', node);
      }
    }

    // SDUI variants can render Languages as plain paragraphs without the
    // usual entity wrappers. Capture each visible language name independently.
    const paragraphLines = cleanedSectionLines(
      Array.from(scope.querySelectorAll('p, h3, h4')).map((el) =>
        norm(el.innerText || el.textContent || '')
      ),
      def
    );
    for (let i = 0; i < paragraphLines.length; i++) {
      const line = paragraphLines[i];
      if (!plausibleLanguage(line)) {
        continue;
      }
      const next = paragraphLines[i + 1] || '';
      addLanguage(line, proficiencyRx.test(next) ? next : '', scope);
    }

    return out;
  }

  function courseItems(container, def) {
    const { nodes } = recordNodesForSection(container, def);
    const out = [];
    const seen = new Set();
    for (const node of nodes) {
      const lines = cleanedSectionLines(recordLines(node), def);
      if (!lines.length) {
        continue;
      }
      const associated = lines.find((line) => /^Associated with\b/i.test(line)) || '';
      const title =
        lines.find((line) => !/^Associated with\b/i.test(line) && !/^Course(?:s)?$/i.test(line)) ||
        '';
      if (!title || title.length > 240) {
        continue;
      }
      const courseNumber =
        lines.find((line) =>
          /^(?:Course\s*(?:No\.?|Number)\s*[:#-]?\s*)?[A-Z]{1,8}[- ]?\d{2,6}$/i.test(line)
        ) || '';
      const sig = `${title}|${courseNumber}|${associated}`.toLowerCase();
      if (seen.has(sig)) {
        continue;
      }
      seen.add(sig);
      out.push(
        itemFromLines([title, ...lines.filter((line) => line !== title)], node, { kind: 'course' })
      );
    }
    return out;
  }

  function testScoreItems(container, def) {
    const { scope, nodes } = recordNodesForSection(container, def);
    const out = [];
    const seen = new Set();
    for (const node of nodes.length ? nodes : [scope]) {
      const lines = cleanedSectionLines(recordLines(node), def);
      if (!lines.length) {
        continue;
      }
      const title =
        lines.find(
          (line) =>
            !/^Score\b/i.test(line) &&
            !/^Associated with\b/i.test(line) &&
            !/^https?:\/\//i.test(line)
        ) || '';
      const score = lines.find((line) => /^Score\b/i.test(line)) || '';
      if (!title) {
        continue;
      }
      const sig = `${title}|${score}`.toLowerCase();
      if (seen.has(sig)) {
        continue;
      }
      seen.add(sig);
      out.push(
        itemFromLines([title, ...lines.filter((line) => line !== title)], node, {
          kind: 'test-score'
        })
      );
    }
    return out;
  }

  function certificationItems(container, def) {
    const { nodes } = recordNodesForSection(container, def);
    const out = [];
    const seen = new Set();
    const metadata =
      /^(?:Issued\b|Expires?\b|Credential ID\b|Show credential\b|See credential\b|Skills?\s*:)/i;
    for (const node of nodes) {
      const lines = cleanedSectionLines(recordLines(node), def).filter(
        (line) => !/^Show credential$/i.test(line)
      );
      if (!lines.length) {
        continue;
      }
      const titleIndex = lines.findIndex((line) => !metadata.test(line));
      if (titleIndex < 0) {
        continue;
      }
      const title = lines[titleIndex];
      const issuer =
        lines
          .slice(titleIndex + 1)
          .find((line) => !metadata.test(line) && !/^https?:\/\//i.test(line)) || '';
      if (!title || title.length > 300) {
        continue;
      }
      const rec = [title];
      if (issuer) {
        rec.push(issuer);
      }
      for (const line of lines.slice(titleIndex + 1)) {
        if (line !== issuer) {
          rec.push(line);
        }
      }
      const sig =
        `${title}|${issuer}|${rec.find((line) => /^Issued\b/i.test(line)) || ''}`.toLowerCase();
      if (seen.has(sig)) {
        continue;
      }
      seen.add(sig);
      out.push(itemFromLines(rec, node, { kind: 'certification' }));
    }
    return out;
  }

  function experienceItems(container) {
    const roots = Array.from(
      container.querySelectorAll('[componentkey^="entity-collection-item"]')
    ).filter((el) => !el.parentElement?.closest('[componentkey^="entity-collection-item"]'));
    const out = [];
    for (const root of roots) {
      const roleLis = Array.from(root.querySelectorAll('ul > li')).filter(
        (li) => li.closest('[componentkey^="entity-collection-item"]') === root
      );
      if (roleLis.length) {
        const directBlocks = Array.from(root.children)
          .filter((ch) => ch.tagName !== 'HR' && ch.tagName !== 'UL')
          .map((ch) => recordLines(ch))
          .filter((lines) => lines.length);
        const headerLines = directBlocks[0] || recordLines(root).slice(0, 2);
        const company = headerLines[0] || '';
        out.push({
          title: company,
          subtitle: headerLines[1] || '',
          details: headerLines.slice(2),
          lines: headerLines,
          text: headerLines.join('\n'),
          depth: 0,
          has_children: true,
          kind: 'experience_group',
          links: linksFrom(root).filter((l) => /\/company\//i.test(l.url))
        });
        for (const li of roleLis) {
          const item = parseRecordNode(li, { depth: 1, group: company, kind: 'experience_role' });
          if (item.text) {
            out.push(item);
          }
        }
      } else {
        const item = parseRecordNode(root, { kind: 'experience_role' });
        if (item.text) {
          out.push(item);
        }
      }
    }
    return out.length ? out : genericRecordItems(container, defByKey('experience'));
  }

  function skillItems(container) {
    const nodes = Array.from(
      container.querySelectorAll('[componentkey^="com.linkedin.sdui.profile.skill("]')
    )
      .filter((el) => !String(el.getAttribute('componentkey') || '').endsWith('-divider'))
      .filter(
        (el) => !el.parentElement?.closest('[componentkey^="com.linkedin.sdui.profile.skill("]')
      );
    const out = [];
    const seen = new Set();
    for (const node of nodes) {
      const lines = recordLines(node);
      const skill = lines[0] || '';
      if (!skill || seen.has(skill.toLowerCase())) {
        continue;
      }
      seen.add(skill.toLowerCase());
      out.push({
        title: skill,
        subtitle: '',
        details: lines.slice(1),
        lines,
        text: lines.join('\n'),
        depth: 0,
        has_children: false,
        links: linksFrom(node)
      });
    }
    return out.length ? out : genericRecordItems(container, defByKey('skills'));
  }

  function canonicalizeItems(def, items, sourceScope = 'profile-page') {
    const adapters = globalThis.LinkedInSectionAdapters;
    if (!def?.key || !adapters?.attachCanonical) {
      return items || [];
    }
    const sourceKind =
      sourceScope === 'detail-page' ? 'detail-viewport-dom' : 'profile-viewport-dom';
    return (items || []).map((item) =>
      adapters.attachCanonical(def.key, item, {
        source_kind: sourceKind,
        source_scope: sourceScope,
        source_url: location.href.split('#')[0],
        captured_at: new Date().toISOString()
      })
    );
  }

  function parseAbout(section) {
    const boxes = Array.from(section.querySelectorAll('[data-testid="expandable-text-box"]'))
      .map((el) => norm(el.innerText || el.textContent || ''))
      .filter(Boolean);
    if (boxes.length) {
      return boxes.sort((a, b) => b.length - a.length)[0];
    }
    const raw = cleanCloneText(section);
    return raw
      .replace(/^About\s*/i, '')
      .replace(/(?:…\s*more|see more)\s*$/i, '')
      .trim();
  }

  function sectionItems(def, section) {
    let items;
    if (def.key === 'experience') {
      items = experienceItems(section);
    } else if (def.key === 'skills') {
      items = skillItems(section);
    } else if (def.key === 'languages') {
      items = languageItems(section, def);
    } else if (def.key === 'courses') {
      items = courseItems(section, def);
    } else if (def.key === 'test-scores') {
      items = testScoreItems(section, def);
    } else if (def.key === 'certifications') {
      items = certificationItems(section, def);
    } else {
      items = genericRecordItems(section, def);
    }
    return canonicalizeItems(def, items, 'profile-page');
  }

  function parseProfileSections() {
    const output = [];
    const seen = new Set();
    for (const section of document.querySelectorAll('main section')) {
      const classified = classifySection(section);
      if (!classified) {
        continue;
      }
      const { def, heading } = classified;
      if (seen.has(def.key)) {
        continue;
      }
      seen.add(def.key);

      if (def.key === 'about') {
        output.push({
          key: 'about',
          title: 'About',
          count: null,
          source_url: profileRootUrl(),
          items: [],
          raw_text: parseAbout(section),
          links: []
        });
        continue;
      }
      // LinkedIn renders add-section/null-state cards for profile fields that are
      // not populated. Only keep such a section when real record containers are
      // also present; an Add CTA must never become exported profile data.
      if (hasNullStateAnchor(section, def.key) && !hasStructuredProfileRecordEvidence(section)) {
        continue;
      }
      const items = sectionItems(def, section);
      output.push({
        key: def.key,
        title: def.title,
        slug: def.slug || '',
        generic: Boolean(def.generic),
        count: countFromTitle(heading),
        source_url: profileRootUrl(),
        items,
        raw_text: cleanCloneText(section),
        links: linksFrom(section)
      });
    }
    return output;
  }

  function uniqueWebsites(websites) {
    const seen = new Set();
    const out = [];
    for (const site of websites || []) {
      if (!site?.url || seen.has(site.url)) {
        continue;
      }
      seen.add(site.url);
      out.push(site);
    }
    return out;
  }

  function visibleContactDialog() {
    const visible = (el) => el?.isConnected && el.getClientRects().length > 0;
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,p')).find(
      (el) =>
        visible(el) &&
        /^contact info$/i.test(norm(el.textContent)) &&
        (el.closest('[role="dialog"], dialog[open], [aria-modal="true"]') || !el.closest('main'))
    );
    if (!heading) {
      return null;
    }
    const modal = heading.closest('[role="dialog"], dialog[open], [aria-modal="true"]');
    if (visible(modal)) {
      return modal;
    }
    // SDUI sometimes puts the title, content and close control in siblings.
    // Select their common bounded container, not just the content component.
    let node = heading.parentElement;
    for (let i = 0; node && node !== document.body && i < 8; i++, node = node.parentElement) {
      if (
        node.querySelector('button, [role="button"]') &&
        node.querySelector('a[href], [componentkey*="ContactInfo" i]') &&
        !node.querySelector('main') &&
        norm(node.textContent).length < 12000
      ) {
        return node;
      }
    }
    return null;
  }

  async function closeContactDialog(profileUrl) {
    updateCaptureHud('Contact info · closing dialog before profile capture…');
    let dialog = visibleContactDialog();
    if (dialog) {
      const controls = Array.from(dialog.querySelectorAll('button, [role="button"]'));
      const close = controls.find((el) => {
        const label = norm(
          `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`
        );
        return (
          /\b(close|dismiss)\b/i.test(label) ||
          el.querySelector('[data-test-icon*="close"], use[href*="close"]')
        );
      });
      if (close) {
        close.click();
      } else {
        dialog.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })
        );
      }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      dialog = visibleContactDialog();
      if (!dialog && runtime.samePageUrl(location.href, profileUrl)) {
        return;
      }
      await sleep(150);
    }
    const error = new Error(
      'Contact info could not close. Close the dialog, refresh the profile, and retry with Include contact info switched off.'
    );
    error.code = 'CONTACT_DIALOG_BLOCKED';
    throw error;
  }

  async function scrapeContactInfo() {
    const originalProfileUrl = profileRootUrl();
    updateCaptureHud('Contact info · waiting for dialog content…');
    const trigger = document.querySelector(
      'a[href*="/overlay/contact-info/"], a[href*="contact-info"]'
    );
    if (!trigger) {
      return {
        available: false,
        items: [],
        raw_text: '',
        websites: [],
        profile_url: originalProfileUrl
      };
    }

    let dialog = null;
    try {
      trigger.click();
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        if (captureBudgetExpired()) {
          break;
        }
        dialog = visibleContactDialog();
        if (dialog && dialog.querySelector('a[href]') && !detailIsLoading(dialog)) {
          await sleep(500);
          dialog = visibleContactDialog();
          if (dialog) {
            break;
          }
        }
        await sleep(180);
      }
      if (!dialog) {
        return {
          available: true,
          items: [],
          raw_text: '',
          websites: [],
          profile_url: originalProfileUrl,
          warning: 'Contact dialog did not load.'
        };
      }

      const items = [];
      const websites = [];
      const seen = new Set();
      const blocks = Array.from(dialog.querySelectorAll('section, li, [data-view-name], div'));

      function add(label, value, links = []) {
        label = norm(label);
        value = norm(value);
        const signature = `${label}|${value}|${links.map((x) => x.url).join(',')}`.toLowerCase();
        if ((!label && !value && !links.length) || seen.has(signature)) {
          return;
        }
        seen.add(signature);
        items.push({ label: label || 'Contact', value, lines: value ? [value] : [], links });
      }

      // Strong href semantics first.
      for (const a of dialog.querySelectorAll('a[href]')) {
        const rawHref = a.getAttribute('href') || '';
        const text = norm(a.innerText || a.textContent || '');
        if (/^mailto:/i.test(rawHref)) {
          add('Email', rawHref.replace(/^mailto:/i, ''), []);
        } else if (/^tel:/i.test(rawHref)) {
          add('Phone', rawHref.replace(/^tel:/i, ''), []);
        } else {
          const url = unwrapLinkedInRedirect(rawHref);
          if (!runtime.safeLink(url) || /linkedin\.com\/in\/[^/]+\/?$/i.test(url)) {
            continue;
          }
          const label = /website|portfolio|blog|company/i.test(text) ? text : 'Website';
          add(label || 'Website', url, [{ text: text || url, url }]);
          if (!/linkedin\.com\//i.test(url)) {
            websites.push({ label: label || 'Website', url });
          }
        }
      }

      // Then capture short labelled blocks for birthday/address/IM fields that
      // do not have semantic hrefs. Nearest heading or first line becomes label.
      for (const block of blocks) {
        const lines = textLines(block, { keepUi: true }).filter(
          (line) => !/^contact info$/i.test(line)
        );
        if (lines.length < 2 || lines.length > 6) {
          continue;
        }
        const heading = norm(block.querySelector('h2, h3, h4')?.innerText || '');
        const label = heading || lines[0];
        const value = lines.filter((x) => x !== label && !/^close$/i.test(x)).join(' | ');
        if (
          /^(?:birthday|address|email|phone|website|profile|instant messaging|connected)$/i.test(
            label
          )
        ) {
          add(label, value, linksFrom(block));
        }
      }

      const rawText = cleanCloneText(dialog);
      return {
        available: true,
        items,
        raw_text: rawText,
        websites: uniqueWebsites(websites),
        profile_url: originalProfileUrl
      };
    } catch (error) {
      return {
        available: true,
        items: [],
        raw_text: '',
        websites: [],
        profile_url: originalProfileUrl,
        warning: error?.message || String(error)
      };
    } finally {
      // Do not begin scrolling beneath a remaining modal, even if parsing
      // failed or LinkedIn rendered a different dialog structure.
      await closeContactDialog(originalProfileUrl);
    }
  }

  function detailLinksFromPage(sections) {
    const root = profileRootUrl();
    const byKey = new Map();
    const sectionMap = new Map((sections || []).map((section) => [section.key, section]));

    function add(def, url, expectedCount = null) {
      if (!def?.key || !def?.slug || !url || !IMPORTANT_SECTION_KEYS.has(def.key)) {
        return;
      }
      const absolute = absoluteUrl(url);
      if (!absolute.startsWith(root)) {
        return;
      }
      const existing = byKey.get(def.key);
      const count =
        expectedCount || sectionMap.get(def.key)?.count || existing?.expectedCount || null;
      byKey.set(def.key, {
        key: def.key,
        title: def.title,
        slug: def.slug || '',
        url: `${root}details/${def.slug}/`,
        expectedCount: count
      });
    }

    for (const a of document.querySelectorAll('main a[href*="/details/"]')) {
      const href = absoluteUrl(a.getAttribute('href'));
      const slug = href.match(/\/details\/([^/?#]+)/i)?.[1] || '';
      const def =
        defBySlug(slug) ||
        sectionDefFromTitle(norm(a.innerText || a.getAttribute('aria-label') || '')) ||
        dynamicSectionDef(titleFromSlug(slug), slug);
      if (def) {
        add(
          def,
          href,
          Number(
            norm(a.innerText || a.getAttribute('aria-label') || '')
              .match(/show all ([\d,]+)/i)?.[1]
              ?.replaceAll(',', '')
          ) || null
        );
      }
    }

    for (const section of sections || []) {
      for (const link of section.links || []) {
        const slug = link.url?.match(/\/details\/([^/?#]+)/)?.[1];
        const def = defBySlug(slug || '');
        if (def && def.key === section.key) {
          add(
            def,
            link.url,
            Number(
              String(link.text || '')
                .match(/show all ([\d,]+)/i)?.[1]
                ?.replaceAll(',', '')
            ) || section.count
          );
        }
      }
    }

    // Do not queue LinkedIn's ProfileNullStateCardAnchor_* placeholders.
    // Their name is literal: they represent an optional section with no data yet.
    // Treating them as detail-page evidence causes unnecessary navigation and
    // can leave the exporter waiting on an empty page.

    // A skills preview is evidence of a detail section even when LinkedIn
    // renders Show all as a button or unmounts the link during scrolling.
    for (const section of sections || []) {
      const def = defByKey(section.key);
      if (!def?.slug || byKey.has(def.key)) {
        continue;
      }
      const expected = Number(section.count || 0);
      const visible =
        def.key === 'experience'
          ? (section.items || []).filter((item) => !item.has_children).length
          : (section.items || []).filter((item) => (item.depth || 0) === 0).length;
      if (expected > visible || (def.key === 'skills' && visible > 0)) {
        add(def, `${root}details/${def.slug}/`, expected);
      }
    }

    return Array.from(byKey.values()).filter(
      (link) => IMPORTANT_SECTION_KEYS.has(link.key) && link.key !== 'about'
    );
  }

  function detailRoot(expectedKey, expectedSlug, expectedTitle) {
    const def =
      defByKey(expectedKey) ||
      defBySlug(expectedSlug) ||
      sectionDefFromTitle(expectedTitle) ||
      dynamicSectionDef(expectedTitle, expectedSlug);
    const suffixes = DETAIL_ROOT_SUFFIX[def?.key] || [];
    for (const suffix of suffixes) {
      const el = document.querySelector(`[componentkey$="${suffix}"], [id$="${suffix}"]`);
      if (el) {
        return { root: el, def, exact: true };
      }
    }

    // Generic detail pages still live under the SDUI Primary content section.
    const primary = document.querySelector('main section[aria-label="Primary content"]');
    if (primary) {
      const probe = norm(primary.innerText || '').slice(0, 2400);
      const title = stripCountFromTitle(def?.title || expectedTitle || titleFromSlug(expectedSlug));
      const hasExpected = title && probe.toLowerCase().includes(title.toLowerCase());
      const narrowed = narrowSectionScope(primary, def) || primary;
      return {
        root: narrowed,
        def,
        exact: Boolean(hasExpected && narrowed !== primary),
        titleEvidence: Boolean(hasExpected),
        scopeKind: narrowed !== primary ? 'narrowed-primary' : 'primary'
      };
    }
    return {
      root: document.querySelector('main') || document.body,
      def,
      exact: false,
      titleEvidence: false,
      scopeKind: 'main-fallback'
    };
  }

  async function activateChoice(root, label) {
    const candidates = Array.from(root.querySelectorAll('[role="tab"], [role="radio"], button'));
    const target = candidates.find(
      (el) => norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '') === label
    );
    if (
      !target ||
      target.disabled ||
      target.getAttribute('aria-selected') === 'true' ||
      target.getAttribute('aria-checked') === 'true' ||
      target.getAttribute('aria-pressed') === 'true'
    ) {
      return false;
    }
    try {
      target.click();
      await sleep(500);
      return true;
    } catch (_) {
      return false;
    }
  }

  function countItemsForExpectation(def, items) {
    if (!Array.isArray(items)) {
      return 0;
    }
    if (def?.key === 'experience') {
      return items.filter((item) => !item.has_children).length;
    }
    return items.filter((item) => (item.depth || 0) === 0).length;
  }

  async function scanVirtualizedDetail(
    def,
    getState,
    add,
    {
      group = '',
      expectedCount = 0,
      maxSteps = 18,
      foreground = false,
      jobId = '',
      sectionTitle = '',
      onCheckpoint = null
    } = {}
  ) {
    let state = getState();
    let root = state.root;
    let scrollNode = findScrollContainer(root);
    window.__liExporterScrollInfo = { container: describeScrollContainer(scrollNode) };
    let steps = 0;
    let idleSince = Date.now();
    let observedCount = -1;
    let observedHeight = -1;
    let noMovement = 0;
    let lastCheckpoint = 0;

    const captureCurrentViewport = () => {
      state = getState();
      root = state.root;
      addRenderedText(root);
      add(collectItemsForDetail(def, root, group));
      return window.__liExporterCollectedCount || 0;
    };

    // Capture first. Never scroll away from a mounted LinkedIn record before
    // preserving its structured fields and evidence.
    captureCurrentViewport();
    const initialExpanded = await clickSeeMore(root, { visibleOnly: true });
    if (initialExpanded) {
      await sleep(foreground ? 240 : 100);
      captureCurrentViewport();
    }

    while (steps <= Math.min(maxSteps, 160)) {
      if (onCheckpoint && Date.now() - lastCheckpoint >= 3000) {
        lastCheckpoint = Date.now();
        await onCheckpoint();
      }
      if (captureBudgetExpired()) {
        break;
      }
      const currentTotal = captureCurrentViewport();
      const candidateScrollNode = findScrollContainer(root);
      if (
        candidateScrollNode !== scrollNode &&
        (!scrollNode?.isConnected ||
          scrollMetrics(candidateScrollNode).max > scrollMetrics(scrollNode).max + 120)
      ) {
        scrollNode = candidateScrollNode;
        window.__liExporterScrollInfo = { container: describeScrollContainer(scrollNode) };
      }
      let metrics = scrollMetrics(scrollNode);
      const pct =
        metrics.max <= 0
          ? 100
          : Math.min(100, Math.max(0, Math.round((metrics.top / metrics.max) * 100)));
      const title = sectionTitle || def?.title || 'LinkedIn section';
      const phase = expectedCount
        ? `Captured ${currentTotal}/${expectedCount} · forward ${pct}%`
        : `Captured ${currentTotal} · forward ${pct}%`;

      emitCaptureProgress(jobId, {
        event: 'section-capture',
        url: location.href.split('#')[0],
        title,
        key: def?.key || '',
        expectedCount,
        extractedCount: currentTotal,
        group,
        scrollPercent: pct,
        scrollContainer: describeScrollContainer(scrollNode),
        phase
      });
      if (foreground) {
        updateCaptureHud(`${title} · ${phase}`);
      }

      const expanded = await clickSeeMore(root, { visibleOnly: true });
      if (expanded) {
        await sleep(foreground ? 240 : 100);
        captureCurrentViewport();
        metrics = scrollMetrics(scrollNode);
      }

      if (currentTotal !== observedCount || metrics.scrollHeight !== observedHeight) {
        observedCount = currentTotal;
        observedHeight = metrics.scrollHeight;
        idleSince = Date.now();
      }
      if (metrics.max <= 8 || metrics.top >= metrics.max - 6) {
        const missing = expectedCount > currentTotal;
        const reachedExpected = expectedCount > 0 && currentTotal >= expectedCount;
        const idleLimit = reachedExpected ? 1800 : missing ? 6500 : 2800;
        if (!detailIsLoading(root) && Date.now() - idleSince >= idleLimit) {
          break;
        }
        // Even if a stale spinner remains mounted, never let one section block the
        // full export after the page has stopped yielding new rows for long enough.
        if (Date.now() - idleSince >= Math.max(idleLimit + 2500, 9000)) {
          break;
        }
        await sleep(400);
        captureCurrentViewport();
        scrollNode = findScrollContainer(getState().root);
        continue;
      }

      const stride = Math.max(360, Math.round(metrics.height * (foreground ? 0.8 : 0.62)));
      const nextTop = Math.min(metrics.max, metrics.top + stride);
      if (nextTop <= metrics.top + 4) {
        break;
      }
      const beforeTop = metrics.top;
      const actualTop = foreground
        ? await animateScrollToOn(scrollNode, nextTop, 300)
        : (setScrollTopOn(scrollNode, nextTop, 'auto'),
          await sleep(70),
          scrollMetrics(scrollNode).top);
      await sleep(foreground ? 430 : 180);

      // Immediately preserve newly mounted rows before the next movement.
      captureCurrentViewport();

      if (Math.abs(actualTop - beforeTop) < 3) {
        noMovement += 1;
        const redetected = findScrollContainer(getState().root);
        if (redetected !== scrollNode && scrollMetrics(redetected).max > 8) {
          scrollNode = redetected;
          noMovement = 0;
          continue;
        }
        if (noMovement >= 2) {
          break;
        }
      } else {
        noMovement = 0;
      }
      steps += 1;
    }

    // Final capture only; deliberately never reset scrollTop to zero. Missing
    // expected records are reported as incomplete rather than triggering a
    // second traversal.
    captureCurrentViewport();
  }

  function collectItemsForDetail(def, root, group = '') {
    // Never manufacture one giant "record" from the whole detail page. That
    // v1.4 fallback is what turned Courses/footer/ad text into dozens of records.
    // If no bounded record containers are present, return zero structured items
    // and let the later conservative evidence reconciliation decide what can be
    // recovered without guessing.
    let items = sectionItems(def, root);
    if (group) {
      for (const item of items) {
        item.group = group;
      }
    }
    return items;
  }

  function detailIsLoading(root) {
    return Array.from(
      root?.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"], .artdeco-loader, .artdeco-spinner'
      ) || []
    ).some((el) => el.getClientRects().length > 0);
  }

  function assertDetailRoute(expectedSlug) {
    const expected = `${captureRun.profileUrl}details/${expectedSlug}/`;
    if (!runtime.samePageUrl(location.href, expected)) {
      throw new Error(
        'The expected section URL changed. Capture stopped to avoid exporting the wrong page.'
      );
    }
  }

  async function waitForDetailRoot(expectedKey, expectedSlug, expectedTitle, timeoutMs = 20000) {
    const started = Date.now();
    const deadline = started + timeoutMs;
    let structuredReadySince = 0;
    let stableSince = 0;
    let lastSignature = '';
    let bestState = null;
    let bestVerified = false;
    updateCaptureHud(`${expectedTitle} · waiting for section content to settle…`);

    while (Date.now() < deadline) {
      assertDetailRoute(expectedSlug);
      if (isLinkedInMissingPage()) {
        return {
          ...detailRoot(expectedKey, expectedSlug, expectedTitle),
          absent: true,
          verified: false,
          readiness: 'optional-section-missing-page'
        };
      }
      if (isLinkedInErrorPage() || isLinkedInAccessGate()) {
        throw new Error('LinkedIn cannot load this section.');
      }

      const state = detailRoot(expectedKey, expectedSlug, expectedTitle);
      const text = norm(state.root?.innerText || state.root?.textContent || '');
      const headings = Array.from(
        state.root?.querySelectorAll('h1, h2, h3, [role="heading"]') || []
      );
      const heading = headings.some((el) => {
        const value = norm(el.textContent || '');
        return (
          sectionDefFromTitle(value)?.key === expectedKey ||
          sectionHeadingPattern(state.def).test(value)
        );
      });
      const title = stripCountFromTitle(
        state.def?.title || expectedTitle || titleFromSlug(expectedSlug)
      ).toLowerCase();
      const titleEvidence =
        Boolean(state.titleEvidence) ||
        Boolean(title && text.slice(0, 2500).toLowerCase().includes(title));
      const expectedEvidence = Boolean(state.exact || heading || titleEvidence);
      const verifiedScope =
        expectedEvidence || ['primary', 'narrowed-primary'].includes(state.scopeKind);
      const hasRows = collectItemsForDetail(state.def, state.root).length > 0;
      const loading = detailIsLoading(state.root);
      const meaningfulText = text.length >= 24;
      const explicitNoData = /(?:hasn[’']?t added|has not added|no .{0,40} yet|nothing to show|no .{0,40} to (?:show|display)|not provided)/i.test(
        text.slice(0, 4000)
      );
      const signature = `${text.length}|${text.slice(0, 900)}|${hasRows ? 1 : 0}|${loading ? 1 : 0}`;

      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      } else if (!stableSince) {
        stableSince = Date.now();
      }

      if (meaningfulText && (!bestState || text.length > (bestState.__textLength || 0))) {
        bestState = { ...state, __textLength: text.length };
        bestVerified = verifiedScope;
      }

      if (verifiedScope && hasRows && !loading) {
        structuredReadySince ||= Date.now();
        if (Date.now() - structuredReadySince >= 700) {
          return { ...state, verified: true, readiness: 'structured' };
        }
      } else {
        structuredReadySince = 0;
      }

      // An optional section can legitimately have no records. If LinkedIn explicitly
      // says there is no data, or the detail route has settled without any section
      // evidence or bounded records, treat it as absent and continue the export.
      const stableFor = stableSince ? Date.now() - stableSince : 0;
      const elapsed = Date.now() - started;
      if (
        !expectedEvidence &&
        !hasRows &&
        meaningfulText &&
        !loading &&
        stableFor >= (explicitNoData ? 900 : 1800) &&
        elapsed >= (explicitNoData ? 1800 : 6500)
      ) {
        return { ...state, absent: true, verified: false, readiness: 'optional-section-not-present' };
      }

      // Do not deadlock on a visually loaded section merely because LinkedIn has
      // changed its record wrappers. Once the expected route is verified and the
      // rendered section has stopped changing, capture it and let the conservative
      // fallback reconciler recover supported records from the visible text.
      if (
        verifiedScope &&
        meaningfulText &&
        !loading &&
        stableFor >= 1200 &&
        Date.now() - started >= 1400
      ) {
        return { ...state, verified: true, readiness: 'rendered-stable' };
      }

      // Some LinkedIn loaders remain mounted after the usable content is already
      // visible. After a bounded grace period, prefer progress over an infinite wait.
      if (verifiedScope && meaningfulText && Date.now() - started >= 8000 && stableFor >= 1000) {
        return { ...state, verified: true, readiness: 'rendered-loader-timeout' };
      }

      await sleep(250);
    }

    if (bestState && bestVerified) {
      const { __textLength, ...state } = bestState;
      return { ...state, verified: true, readiness: 'rendered-timeout-fallback' };
    }
    throw new Error(
      `The ${expectedTitle || 'section'} page did not render usable content within ${Math.round(timeoutMs / 1000)} seconds.`
    );
  }

  function absentDetailResult(expectedTitle, expectedKey, expectedSlug, readiness = 'optional-section-not-present') {
    const def =
      defByKey(expectedKey) ||
      defBySlug(expectedSlug) ||
      sectionDefFromTitle(expectedTitle) ||
      dynamicSectionDef(expectedTitle, expectedSlug || expectedKey);
    const title = def?.title || stripCountFromTitle(expectedTitle) || titleFromSlug(expectedSlug);
    return {
      section: {
        key: def?.key || stableSectionKey(expectedKey || expectedSlug || title),
        title,
        slug: expectedSlug || def?.slug || '',
        source_url: location.href.split('#')[0],
        items: [],
        raw_text: '',
        rendered_text_snapshot: '',
        links: [],
        available: false,
        skipped: true,
        skip_reason: 'not-present',
        extraction: {
          exporter_version: VERSION,
          readiness_mode: readiness,
          expected_count: null,
          extracted_count: 0,
          complete: true,
          optional_section: true,
          budget_expired: false
        }
      }
    };
  }

  async function scrapeDetailPage(
    expectedTitle = '',
    expectedKey = '',
    expectedSlug = '',
    expectedCount = 0,
    foreground = false,
    jobId = ''
  ) {
    // Document completion does not guarantee that LinkedIn has rendered records.
    // The section readiness check below also waits for route-specific content.
    if (document.readyState !== 'complete') {
      const deadline = Date.now() + 10000;
      while (document.readyState !== 'complete' && Date.now() < deadline) {
        await sleep(100);
      }
    }
    if (isLinkedInMissingPage()) {
      return absentDetailResult(
        expectedTitle,
        expectedKey,
        expectedSlug,
        'optional-section-missing-page'
      );
    }
    if (isLinkedInErrorPage()) {
      throw new Error('LinkedIn reports a temporary problem while loading this section.');
    }
    let state = await waitForDetailRoot(expectedKey, expectedSlug, expectedTitle);
    if (state?.absent) {
      return absentDetailResult(expectedTitle, expectedKey, expectedSlug, state.readiness);
    }
    captureDeadline = Date.now() + DETAIL_CAPTURE_BUDGET_MS;
    addRenderedText(state.root);
    const def = state.def || dynamicSectionDef(expectedTitle, expectedSlug || expectedKey);
    expectedCount =
      expectedCount ||
      countFromTitle(norm(state.root.querySelector('h1, h2, h3')?.textContent || '')) ||
      0;
    const initialExact = Boolean(state.exact);
    const initialVerified = Boolean(state.verified || state.exact || state.titleEvidence);
    const readinessMode = state.readiness || (initialExact ? 'structured' : 'unknown');
    const collected = [];
    const indexByIdentity = new Map();

    function add(items) {
      const adapters = globalThis.LinkedInSectionAdapters;
      for (const item of items || []) {
        if (!item?.text) {
          continue;
        }
        const recordIdentity =
          adapters?.identity?.(def?.key, item) ||
          adapters?.signature?.(def?.key, item) ||
          norm(item.text || '').toLowerCase();
        const identity = `${norm(item.group || '').toLowerCase()}|${recordIdentity}`;
        if (recordIdentity && indexByIdentity.has(identity)) {
          const index = indexByIdentity.get(identity);
          collected[index] = mergeCapturedItem(def?.key || '', collected[index], item);
          continue;
        }
        if (recordIdentity) {
          indexByIdentity.set(identity, collected.length);
        }
        collected.push(item);
      }
      window.__liExporterCollectedCount = countItemsForExpectation(def, collected);
    }

    const getState = () => {
      assertDetailRoute(expectedSlug);
      return detailRoot(expectedKey, expectedSlug, expectedTitle);
    };
    const onCheckpoint = async () => {
      if (!captureRun) {
        return;
      }
      await sendCaptureMessage({
        type: 'CAPTURE_CHECKPOINT',
        kind: 'detail',
        jobId,
        captureToken: captureRun.token,
        section: {
          key: def.key,
          title: def.title,
          count: expectedCount || null,
          source_url: location.href,
          items: canonicalizeItems(def, collected, 'detail-page'),
          available: collected.length > 0
        }
      });
    };

    if (def?.key === 'skills') {
      await activateChoice(state.root, 'All');
      await waitForDetailRoot(expectedKey, expectedSlug, expectedTitle);
      await scanVirtualizedDetail(def, getState, add, {
        expectedCount,
        maxSteps: 160,
        foreground,
        jobId,
        onCheckpoint,
        sectionTitle: expectedTitle || def?.title || ''
      });
    } else {
      await scanVirtualizedDetail(def, getState, add, {
        expectedCount,
        maxSteps: 160,
        foreground,
        jobId,
        onCheckpoint,
        sectionTitle: expectedTitle || def?.title || ''
      });
    }

    state = getState();
    const rawText = cleanCloneText(state.root);
    const title = def?.title || stripCountFromTitle(expectedTitle) || titleFromSlug(expectedSlug);
    const countMatch = rawText.match(
      new RegExp(`${String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\((\\d+)\\)`, 'i')
    );
    const resolvedCount = expectedCount || (countMatch ? Number(countMatch[1]) : null);
    const actualCount = countItemsForExpectation(def, collected);

    delete window.__liExporterCollectedCount;
    const canonicalCollected = canonicalizeItems(def, collected, 'detail-page');

    return {
      section: {
        key: def?.key || stableSectionKey(expectedKey || expectedSlug || title),
        title,
        slug: expectedSlug || def?.slug || '',
        generic: Boolean(def?.generic),
        count: resolvedCount,
        source_url: location.href.split('#')[0],
        items: canonicalCollected,
        raw_text: rawText,
        rendered_text_snapshot: renderedTextSnapshot(),
        links: linksFrom(state.root),
        available: initialExact || collected.length > 0,
        extraction: {
          dom_family: 'linkedin-sdui',
          root_suffixes: DETAIL_ROOT_SUFFIX[def?.key] || [],
          exact_root: initialExact,
          verified_scope: initialVerified,
          readiness_mode: readinessMode,
          exporter_version: VERSION,
          expected_count: resolvedCount || null,
          extracted_count: actualCount,
          complete: resolvedCount ? actualCount >= resolvedCount : null,
          visibility_state: document.visibilityState,
          max_scroll_passes: 1,
          capture_budget_ms: expectedKey ? DETAIL_CAPTURE_BUDGET_MS : PROFILE_CAPTURE_BUDGET_MS,
          budget_expired: captureBudgetExpired()
        }
      }
    };
  }

  async function scrapeProfile(includeContact, foreground = false, jobId = '') {
    const canonicalUrl = profileRootUrl();
    // Preserve top-of-profile fields before the first movement. Contact info is
    // opened and closed before scrolling so the forward traversal does not need
    // to return to the top later.
    const top = parseTopCard();
    const images = findProfileImages();
    const initialWebsites = topCardWebsites();
    const contact = includeContact
      ? await scrapeContactInfo()
      : { available: false, items: [], raw_text: '', websites: [], profile_url: canonicalUrl };
    if (includeContact && (!contact.websites || !contact.websites.length)) {
      contact.websites = initialWebsites;
    }

    const onCheckpoint = async (sections) => {
      if (!captureRun) {
        return;
      }
      await sendCaptureMessage({
        type: 'CAPTURE_CHECKPOINT',
        kind: 'profile',
        jobId,
        captureToken: captureRun.token,
        data: {
          source_url: canonicalUrl,
          top,
          images,
          contact_info: contact,
          about: sections.find((section) => section.key === 'about')?.raw_text || '',
          sections: sections.filter((section) => section.key !== 'about'),
          detail_links: detailLinksFromPage(sections)
        }
      });
    };
    const sections = await progressiveHydrate({
      restore: false,
      fast: false,
      foreground,
      jobId,
      onCheckpoint
    });
    const aboutSection = sections.find((s) => s.key === 'about');

    return {
      exported_at: new Date().toISOString(),
      source_url: canonicalUrl,
      top,
      about: aboutSection?.raw_text || '',
      contact_info: contact,
      sections: sections.filter((s) => s.key !== 'about'),
      detail_links: detailLinksFromPage(sections),
      images,
      discovered_sections: sections.map((s) => ({
        key: s.key,
        title: s.title,
        count: s.count,
        item_count: s.items?.length || 0
      })),
      rendered_text_snapshot: renderedTextSnapshot(),
      meta: {
        budget_expired: captureBudgetExpired(),
        title: document.title,
        linkedin_language: document.documentElement.lang || '',
        exporter_version: VERSION,
        profile_schema:
          globalThis.LinkedInProfileModel?.SCHEMA_VERSION || 'linkedin-career-profile-v2',
        dom_family: 'linkedin-sdui',
        capture_mode: foreground ? 'foreground-visible' : 'standard',
        max_scroll_passes: 1
      }
    };
  }

  function quickProfileSnapshot(includeContact = false) {
    const sections = parseProfileSections();
    const aboutSection = sections.find((s) => s.key === 'about');
    return {
      exported_at: new Date().toISOString(),
      source_url: profileRootUrl(),
      top: parseTopCard(),
      about: aboutSection?.raw_text || '',
      contact_info: {
        available: false,
        items: [],
        raw_text: '',
        websites: includeContact ? topCardWebsites() : [],
        profile_url: profileRootUrl(),
        warning: 'Checkpoint captured before deep scan.'
      },
      sections: sections.filter((s) => s.key !== 'about'),
      detail_links: detailLinksFromPage(sections),
      images: findProfileImages(),
      discovered_sections: sections.map((s) => ({
        key: s.key,
        title: s.title,
        count: s.count,
        item_count: s.items?.length || 0
      })),
      rendered_text_snapshot: cleanCloneText(document.querySelector('main') || document.body),
      meta: {
        title: document.title,
        linkedin_language: document.documentElement.lang || '',
        exporter_version: VERSION,
        checkpoint: true
      }
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab) {
      return false;
    }
    if (message?.type === 'HUD_JOB_STATE') {
      setHudJob(message.job || null);
      sendResponse?.({ ok: true });
      return;
    }

    if (message?.type === 'GET_CAPTURE_PREFLIGHT') {
      try {
        sendResponse?.({ ok: true, preflight: capturePreflight() });
      } catch (error) {
        sendResponse?.({ ok: false, error: error?.message || String(error) });
      }
      return false;
    }

    if (message?.type === 'RUN_VISIBLE_CAPTURE') {
      if (activeVisibleCapture) {
        sendResponse?.({
          ok: captureRun?.token === message.captureToken,
          started: captureRun?.token === message.captureToken,
          error: 'Another capture is already running.'
        });
        return;
      }
      activeVisibleCapture = true;
      captureRun = {
        token: message.captureToken,
        jobId: message.jobId,
        profileUrl: runtime.canonicalProfileUrl(message.job?.profileUrl || location.href),
        cancelled: false
      };
      setHudJob(message.job || null);
      sendResponse?.({ ok: true, started: true });

      (async () => {
        try {
          resetCaptureLedger(
            message.kind === 'profile' ? PROFILE_CAPTURE_BUDGET_MS : DETAIL_CAPTURE_BUDGET_MS
          );
          if (message.kind === 'profile') {
            const preflight = capturePreflight();
            if (!preflight.ok) {
              throw new Error(
                preflight.accessGate
                  ? 'LinkedIn requires attention before this profile can be exported.'
                  : 'The LinkedIn profile is not ready to capture.'
              );
            }
            if (!preflight.nearTop) {
              throw new Error(
                'Scroll to the top of the LinkedIn profile before starting the export.'
              );
            }
          }
          await waitForContentReady();
          if (message.kind === 'profile') {
            await sendCaptureMessage({
              type: 'CAPTURE_CHECKPOINT',
              jobId: message.jobId || '',
              captureToken: message.captureToken || '',
              kind: 'profile',
              data: quickProfileSnapshot(Boolean(message.includeContact))
            });
          }
          await sleep(120);
          if (message.kind === 'profile') {
            updateCaptureHud('Main profile · starting single forward capture…');
            const data = await scrapeProfile(
              Boolean(message.includeContact),
              true,
              message.jobId || ''
            );
            await sendCaptureMessage({
              type: 'PAGE_CAPTURE_COMPLETE',
              jobId: message.jobId || '',
              captureToken: message.captureToken || '',
              kind: 'profile',
              ok: true,
              data
            });
          } else {
            const title = message.expectedTitle || message.expectedKey || 'Profile section';
            updateCaptureHud(`${title} · starting single forward capture…`);
            const result = await scrapeDetailPage(
              message.expectedTitle || '',
              message.expectedKey || '',
              message.expectedSlug || '',
              Number(message.expectedCount || 0),
              true,
              message.jobId || ''
            );
            await sendCaptureMessage({
              type: 'PAGE_CAPTURE_COMPLETE',
              jobId: message.jobId || '',
              captureToken: message.captureToken || '',
              kind: 'detail',
              ok: true,
              section: result.section
            });
          }
        } catch (error) {
          setHudJob({
            ...(message.job || {}),
            phase: 'error',
            error: error?.message || String(error),
            tasks: [
              {
                key: 'capture',
                title: 'Capture stopped',
                status: 'error',
                detail: error?.message || String(error)
              }
            ]
          });
          updateCaptureHud(error?.message || String(error));
          await sendCaptureMessage({
            type: 'PAGE_CAPTURE_COMPLETE',
            jobId: message.jobId || '',
            captureToken: message.captureToken || '',
            kind: message.kind || 'detail',
            ok: false,
            fatal: ['CONTACT_DIALOG_BLOCKED', 'CAPTURE_HANDOFF_FAILED'].includes(error?.code),
            error: error?.message || String(error)
          }).catch(() => {});
        } finally {
          activeVisibleCapture = false;
          captureRun = null;
        }
      })();
      return;
    }
  });

  setTimeout(() => restoreHudFromJob(), 250);
})();
