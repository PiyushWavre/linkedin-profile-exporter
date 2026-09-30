(() => {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    require('./core/runtime.js');
    require('./core/profile-model.js');
    require('./sections/common.js');
    for (const key of globalThis.LinkedInRuntime.SECTION_KEYS) {
      require(`./sections/${key}.js`);
    }
    require('./sections/section-adapters.js');
  }
  const { norm, cleanLines, looksLikeDate, firstLink } = globalThis.LinkedInSectionCommon;
  const ALLOWED_SECTION_KEYS = new Set([
    'experience',
    'education',
    'certifications',
    'projects',
    'skills',
    'publications',
    'patents',
    'honors',
    'languages',
    'volunteering',
    'courses',
    'test-scores',
    'organizations',
    'services',
    'causes'
  ]);

  const SECTION_TITLES = {
    experience: 'Experience',
    education: 'Education',
    certifications: 'Licenses & Certifications',
    projects: 'Projects',
    skills: 'Skills',
    publications: 'Publications',
    patents: 'Patents',
    honors: 'Honours & Awards',
    languages: 'Languages',
    volunteering: 'Volunteering',
    courses: 'Courses',
    'test-scores': 'Test Scores',
    organizations: 'Organizations',
    services: 'Services',
    causes: 'Causes'
  };

  function sanitizeFilename(value) {
    let name = String(value || 'linkedin-profile')
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex -- Filesystem safety requires rejecting controls.
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-. ]+|[-. ]+$/g, '');
    name =
      Array.from(name)
        .slice(0, 64)
        .join('')
        .replace(/[-. ]+$/g, '') || 'linkedin-profile';
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
      name = `Profile-${name}`;
    }
    // Leave room for the suffix on filesystems with 255-byte component limits.
    while (new TextEncoder().encode(name).length > 180) {
      name = Array.from(name).slice(0, -1).join('');
    }
    return name;
  }

  // Captured text must remain text in Markdown viewers, including About.
  function escMd(value) {
    return norm(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/([\\`*_{}[\]()#!|~+>])/g, '\\$1')
      .replace(/^([ \t]*)([-=]|\d+[.])/gm, '$1\\$2')
      .replace(/\n/g, '\n  ');
  }

  function sectionKey(section) {
    if (section?.key) {
      return String(section.key);
    }
    const raw = String(section?.title || section || '')
      .trim()
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (/honou?rs?-and-awards?/.test(raw)) {
      return 'honors';
    }
    if (/licenses?-and-certifications?|certifications?/.test(raw)) {
      return 'certifications';
    }
    if (/test-scores?/.test(raw)) {
      return 'test-scores';
    }
    if (/^organi[sz]ations?$/.test(raw)) {
      return 'organizations';
    }
    if (/volunteer/.test(raw)) {
      return 'volunteering';
    }
    return raw;
  }

  function recordFields(key, item) {
    return globalThis.LinkedInSectionAdapters.fields(key, item);
  }

  function recordSignature(key, item) {
    return globalThis.LinkedInSectionAdapters.signature(key, item);
  }

  function isPlausibleRecord(key, item) {
    const parts = cleanLines(item);
    if (!parts.length && item?.canonical?.fields) {
      if (item.canonical.validation?.valid === false) {
        return false;
      }
      return Boolean(recordSignature(key, item));
    }
    const first = parts[0] || '';
    if (!first || first.length > 280) {
      return false;
    }
    if (
      /^(?:Ad Options|Why am I seeing this ad\??|Manage your ad preferences|Hide or report this ad|About|Accessibility|Talent Solutions|Community Guidelines|Careers|Marketing Solutions|Privacy\s*&\s*Terms|Ad Choices|Advertising|Sales Solutions|Mobile|Small Business|Safety Center|Questions\??|Select language)$/i.test(
        first
      )
    ) {
      return false;
    }
    const heading = String(SECTION_TITLES[key] || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const firstNorm = first
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (heading && firstNorm === heading) {
      return false;
    }
    if (
      key === 'skills' &&
      /^(?:skills?|all|industry knowledge|tools?\s*&\s*technologies|interpersonal skills|other skills)$/i.test(
        first
      )
    ) {
      return false;
    }
    if (
      key === 'certifications' &&
      (/^(?:licenses?\s*(?:&|and)\s*certifications?|certifications?)$/i.test(first) ||
        /^(?:issued\b|expires?\b|credential id\b|show credential\b|see credential\b|skills?\s*:)/i.test(
          first
        ))
    ) {
      return false;
    }
    if (key === 'projects' && /^projects?projects?/i.test(first.replace(/\s+/g, ''))) {
      return false;
    }
    if (key === 'languages') {
      const proficiencyRx =
        /^(?:Elementary proficiency|Limited working proficiency|Professional working proficiency|Full professional proficiency|Native or bilingual proficiency)$/i;
      if (parts[1] && !proficiencyRx.test(parts[1])) {
        return false;
      }
      if (proficiencyRx.test(first)) {
        return false;
      }
    }
    if (key === 'courses') {
      if (
        /^(?:Courses?|Connect|Message|Follow|Submit)$/i.test(first) ||
        /\|\s*LinkedIn$/i.test(first)
      ) {
        return false;
      }
      if (/^[·•]|^https?:\/\//i.test(first)) {
        return false;
      }
    }
    if (key === 'honors' && /^(?:Issued by\b|Associated with\b)/i.test(first)) {
      return false;
    }
    if (parts.length <= 2 && norm(item?.text || '').length > 700) {
      return false;
    }
    return true;
  }

  function mergeItemArrays(key, arrays) {
    const bySignature = new Map();
    const out = [];
    const adapters = globalThis.LinkedInSectionAdapters;
    const model = globalThis.LinkedInProfileModel;
    for (const items of arrays) {
      for (const rawItem of items || []) {
        let item = rawItem;
        if (!item?.canonical && adapters?.attachCanonical) {
          item = adapters.attachCanonical(key, item, {
            source_kind: item?.recovered_from || 'unknown',
            source_scope: item?.recovered ? 'recovery' : 'export-compat',
            source_url: ''
          });
        }
        if (!isPlausibleRecord(key, item)) {
          continue;
        }
        const sig = recordSignature(key, item);
        const identity = adapters?.identity ? adapters.identity(key, item) : sig;
        if (!identity) {
          continue;
        }
        if (!bySignature.has(identity)) {
          bySignature.set(identity, out.length);
          out.push(item);
          continue;
        }
        const index = bySignature.get(identity);
        const current = out[index];
        if (model?.reconcileCanonical && current?.canonical && item?.canonical) {
          out[index] = {
            ...current,
            canonical: model.reconcileCanonical(current.canonical, item.canonical)
          };
        }
      }
    }
    return out;
  }

  function mergeSections(mainSections, detailSections) {
    const map = new Map();
    const add = (section) => {
      if (!section?.title) {
        return;
      }
      const key = sectionKey(section);
      if (!ALLOWED_SECTION_KEYS.has(key)) {
        return;
      }
      const incomingItems = mergeItemArrays(key, [section.items || []]);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          ...section,
          key,
          title: SECTION_TITLES[key] || section.title,
          items: incomingItems
        });
        return;
      }
      const expected = Math.max(Number(existing.count || 0), Number(section.count || 0)) || null;
      const incomingIsDetail =
        /\/details\//i.test(String(section.source_url || '')) || Boolean(section.extraction);
      let items;
      if (incomingIsDetail && incomingItems.length) {
        const incomingCount =
          key === 'experience'
            ? incomingItems.filter((i) => !i.has_children).length
            : incomingItems.filter((i) => (i.depth || 0) === 0).length;
        items =
          !expected || incomingCount < expected
            ? mergeItemArrays(key, [incomingItems, existing.items || []])
            : incomingItems;
      } else {
        items = mergeItemArrays(key, [existing.items || [], incomingItems]);
      }
      const raw =
        incomingIsDetail && section.raw_text
          ? section.raw_text
          : [existing.raw_text, section.raw_text]
              .filter(Boolean)
              .sort((a, b) => String(b).length - String(a).length)[0] || '';
      map.set(key, {
        ...existing,
        ...section,
        key,
        title: SECTION_TITLES[key] || section.title || existing.title,
        count: expected,
        items,
        raw_text: raw,
        available: existing.available !== false || section.available !== false
      });
    };
    for (const s of mainSections || []) {
      add(s);
    }
    for (const s of detailSections || []) {
      add(s);
    }
    return [...map.values()];
  }

  function fallbackLines(text, title = '') {
    const out = [];
    let previous = '';
    const titleKey = norm(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const skip = [
      /^home$/i,
      /^my network$/i,
      /^jobs$/i,
      /^messaging$/i,
      /^notifications$/i,
      /^me$/i,
      /^for business$/i,
      /^search$/i,
      /^skip to/i,
      /^linkedin$/i,
      /^show all/i,
      /^show more$/i,
      /^see more$/i,
      /^back$/i,
      /^close$/i,
      /^people also viewed/i,
      /^people you may know/i,
      /^more profiles for you/i,
      /^premium$/i,
      /^advertisement$/i,
      /^captured text ledger$/i,
      /^text observed during the single forward visible scroll pass/i,
      /^ad options$/i,
      /^why am i seeing this ad\??$/i,
      /^manage your ad preferences$/i,
      /^hide or report this ad$/i,
      /^report this ad$/i,
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
    for (const raw of String(text || '')
      .replace(/\r/g, '')
      .split(/\n+/)) {
      const line = norm(raw);
      if (!line || line.length > 1200 || skip.some((rx) => rx.test(line))) {
        continue;
      }
      const key = line.toLowerCase();
      const normal = key.replace(/[^a-z0-9]+/g, ' ').trim();
      if (titleKey && (normal === titleKey || normal === `${titleKey} all`)) {
        continue;
      }
      // Preserve repeated field values across different records. v1.2 globally
      // deduplicated lines, which destroyed valid structures such as two Courses
      // sharing the same "Associated with" institution. Only collapse immediate
      // duplicate rendering noise; record deduplication happens later by signature.
      if (key === previous) {
        continue;
      }
      previous = key;
      out.push(line);
    }
    return out;
  }

  function plausibleSkill(line) {
    const v = norm(line);
    if (!v || v.length < 2 || v.length > 110) {
      return false;
    }
    if (
      /^(?:skills?|all|industry knowledge|tools?\s*&\s*technologies|interpersonal skills|other skills)$/i.test(
        v
      )
    ) {
      return false;
    }
    if (
      /\b(?:endorsement|followers?|connections?|issued|credential|present|yrs?|mos?|show|associated with)\b/i.test(
        v
      )
    ) {
      return false;
    }
    if (/^(?:19|20)\d{2}$/.test(v) || /^\d+[,.]?\d*$/.test(v)) {
      return false;
    }
    if (/^https?:\/\//i.test(v)) {
      return false;
    }
    return true;
  }

  function recoveredItem(lines, sourceKind) {
    const clean = (lines || []).map(norm).filter(Boolean);
    return {
      title: clean[0] || '',
      subtitle: clean[1] || '',
      details: clean.slice(2),
      lines: clean,
      text: clean.join('\n'),
      depth: 0,
      has_children: false,
      links: [],
      recovered: true,
      recovered_from: sourceKind || 'saved-source'
    };
  }

  function recoverLanguages(lines) {
    const proficiencyRx =
      /^(?:Elementary proficiency|Limited working proficiency|Professional working proficiency|Full professional proficiency|Native or bilingual proficiency)$/i;
    const skipRx =
      /^(?:Languages?|Show all|Show more|See more|Back|Close|Connect|Message|Follow|Submit|Add)$/i;
    const out = [];
    const seen = new Set();

    // Keep this generic. Language names are user/profile data, not an enum;
    // never restrict capture to a fixed list of known languages.
    const add = (language, proficiency = '') => {
      const lang = norm(language);
      const prof = norm(proficiency);
      if (
        !lang ||
        lang.length > 110 ||
        skipRx.test(lang) ||
        proficiencyRx.test(lang) ||
        /^https?:\/\//i.test(lang) ||
        /^(?:19|20)\d{2}$/.test(lang)
      ) {
        return;
      }
      const key = lang.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push(recoveredItem([lang, proficiencyRx.test(prof) ? prof : ''].filter(Boolean), 'source-text'));
    };

    for (let i = 0; i < lines.length; i++) {
      const line = norm(lines[i]);
      if (!line || proficiencyRx.test(line)) {
        continue;
      }
      const next = norm(lines[i + 1] || '');
      add(line, proficiencyRx.test(next) ? next : '');
    }
    return out;
  }

  function recoverTestScores(lines) {
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      if (!/^Score\b/i.test(lines[i])) {
        continue;
      }
      const test = lines[i - 1];
      if (!test || test.length >= 180 || /^https?:\/\//i.test(test)) {
        continue;
      }
      const rec = [test, lines[i]];
      for (const next of lines.slice(i + 1, i + 5)) {
        if (
          /^Associated with\b/i.test(next) ||
          /^https?:\/\//i.test(next) ||
          (looksLikeDate(next) && !/^Issued\b/i.test(next))
        ) {
          rec.push(next);
        }
      }
      out.push(recoveredItem(rec, 'source-text'));
    }
    return out;
  }

  function recoverCertifications(lines) {
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      if (!/^Issued\b/i.test(lines[i])) {
        continue;
      }
      const prior = [];
      for (let j = i - 1; j >= 0 && prior.length < 2 && i - j <= 6; j--) {
        const value = norm(lines[j]);
        if (
          !value ||
          /^(?:Show credential|See credential|Skills?:|Credential ID|Expires?\b|Issued\b)/i.test(
            value
          )
        ) {
          continue;
        }
        if (/^Associated with\b/i.test(value) || /^https?:\/\//i.test(value)) {
          continue;
        }
        prior.unshift(value);
      }
      const maybeName = prior[0] || '';
      const maybeIssuer = prior[1] || '';
      if (!maybeName || !maybeIssuer || looksLikeDate(maybeIssuer)) {
        continue;
      }
      const rec = [maybeName, maybeIssuer, lines[i]];
      for (const next of lines.slice(i + 1, i + 5)) {
        if (/^(?:Expires?\b|Credential ID\b)/i.test(next)) {
          rec.push(next);
        }
      }
      out.push(recoveredItem(rec, 'source-text'));
    }
    return out;
  }

  function recoverCourses(lines) {
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      if (!/^Associated with\b/i.test(lines[i])) {
        continue;
      }
      const number = /^(?:Course\s*(?:No\.?|Number)\s*[:#-]?\s*)?[A-Z]{1,8}[- ]?\d{2,6}$/i.test(
        lines[i - 1]
      )
        ? lines[i - 1]
        : '';
      const course = norm(lines[i - (number ? 2 : 1)]);
      if (!course || course.length < 3 || course.length > 220) {
        continue;
      }
      if (looksLikeDate(course) || /^Course(?:s)?$/i.test(course) || /^https?:\/\//i.test(course)) {
        continue;
      }
      if (
        /^(?:Connect|Message|Follow|About|Accessibility|Select language|Ad Options)$/i.test(course)
      ) {
        continue;
      }
      out.push(recoveredItem([course, number, lines[i]].filter(Boolean), 'source-text'));
    }
    return out;
  }

  function recoverHonors(lines) {
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      if (!/^Issued by\b/i.test(lines[i])) {
        continue;
      }
      let award = '';
      for (let j = i - 1; j >= 0 && i - j <= 4; j--) {
        const candidate = norm(lines[j]);
        if (!candidate || /^(?:Associated with|Show all|See more|Show more)$/i.test(candidate)) {
          continue;
        }
        award = candidate;
        break;
      }
      if (!award || award.length > 280) {
        continue;
      }
      const rec = [award, lines[i]];
      for (const next of lines.slice(i + 1, i + 4)) {
        if (/^Associated with\b/i.test(next)) {
          rec.push(next);
        }
      }
      out.push(recoveredItem(rec, 'source-text'));
    }
    return out;
  }

  function countSectionRecords(section) {
    const key = sectionKey(section);
    const items = section?.items || [];
    if (key === 'experience') {
      return items.filter((item) => !item.has_children).length;
    }
    return items.filter((item) => (item.depth || 0) === 0).length;
  }

  function recoverItemsForSection(key, lines) {
    if (key === 'skills') {
      return lines.filter(plausibleSkill).map((line) => recoveredItem([line], 'source-text'));
    }
    if (key === 'languages') {
      return recoverLanguages(lines);
    }
    if (key === 'test-scores') {
      return recoverTestScores(lines);
    }
    if (key === 'certifications') {
      return recoverCertifications(lines);
    }
    if (key === 'courses') {
      return recoverCourses(lines);
    }
    if (key === 'honors') {
      return recoverHonors(lines);
    }
    return [];
  }

  function applyFallbackText(sections, fallbacks) {
    const map = new Map(
      (sections || [])
        .filter((s) => ALLOWED_SECTION_KEYS.has(sectionKey(s)))
        .map((section) => [sectionKey(section), section])
    );
    const grouped = new Map();
    for (const fallback of fallbacks || []) {
      const key = fallback?.key
        ? String(fallback.key)
        : sectionKey({ title: fallback?.title || '' });
      if (!ALLOWED_SECTION_KEYS.has(key)) {
        continue;
      }
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push(fallback);
    }

    for (const [key, sources] of grouped) {
      let section = map.get(key);
      if (!section) {
        section = {
          key,
          title: SECTION_TITLES[key] || key,
          slug: '',
          count: null,
          source_url: sources[0]?.url || '',
          items: [],
          raw_text: '',
          available: true
        };
        map.set(key, section);
      }
      const expected =
        Math.max(
          Number(section.count || 0),
          ...sources.map((s) => Number(s.expected_count || 0))
        ) || 0;
      const before = countSectionRecords(section);
      const recoveryCandidates = [];
      for (const source of sources) {
        if (!source?.text) {
          continue;
        }
        const missingLines = fallbackLines(source.text, section.title);
        for (let item of recoverItemsForSection(key, missingLines)) {
          item.recovered_from = source.source_kind || item.recovered_from || 'saved-source';
          if (globalThis.LinkedInSectionAdapters?.attachCanonical) {
            item = globalThis.LinkedInSectionAdapters.attachCanonical(key, item, {
              source_kind: item.recovered_from,
              source_scope: 'recovery',
              source_url: source.url || section.source_url || '',
              captured_at: new Date().toISOString()
            });
          }
          recoveryCandidates.push(item);
        }
      }
      section.items = mergeItemArrays(key, [section.items || [], recoveryCandidates]);
      if (
        expected &&
        countSectionRecords(section) > expected &&
        ['skills', 'languages', 'courses', 'test-scores', 'certifications', 'honors'].includes(key)
      ) {
        const keep = [];
        let counted = 0;
        for (const item of section.items) {
          const counts = key === 'experience' ? !item.has_children : (item.depth || 0) === 0;
          if (counts && counted >= expected && item.recovered) {
            continue;
          }
          keep.push(item);
          if (counts) {
            counted++;
          }
        }
        section.items = keep;
      }
      const after = countSectionRecords(section);
      section.count = expected || section.count || null;
      section.reconciliation = {
        expected_count: expected || null,
        structured_count: before,
        recovered_count: Math.max(0, after - before),
        final_count: after,
        status: expected
          ? after >= expected
            ? 'complete'
            : 'possibly-incomplete'
          : after
            ? 'captured'
            : 'empty',
        sources: [...new Set(sources.map((s) => s.source_kind || 'saved-source'))]
      };
    }
    return [...map.values()];
  }

  function fieldLine(label, value) {
    const v = Array.isArray(value) ? value.filter(Boolean).join(' | ') : norm(value);
    return v ? `- ${label}: ${escMd(v)}` : '';
  }

  function pushDescription(out, value) {
    const values = Array.isArray(value)
      ? value.map(norm).filter(Boolean)
      : [norm(value)].filter(Boolean);
    if (!values.length) {
      return;
    }
    out.push('- Description:');
    for (const line of values) {
      out.push(`  - ${escMd(line)}`);
    }
  }

  function pushRecord(out, heading, fields, descriptions = []) {
    out.push(`### ${escMd(heading || 'Record')}`, '');
    for (const [label, value] of fields) {
      const line = fieldLine(label, value);
      if (line) {
        out.push(line);
      }
    }
    pushDescription(out, descriptions);
    out.push('');
  }

  function formatExperience(section) {
    const out = [];
    let group = '';
    for (const item of section.items || []) {
      const f = recordFields('experience', item);
      if (f.record_type === 'company_group') {
        group = f.company;
        out.push(`### ${escMd(f.company)}`, '');
        if (f.overall_duration) {
          out.push(fieldLine('Overall duration', f.overall_duration));
        }
        if (f.details?.length) {
          pushDescription(out, f.details);
        }
        if (out.at(-1) !== '') {
          out.push('');
        }
        continue;
      }
      if (!f.title) {
        continue;
      }
      const company = f.company || group;
      if (company && company !== group) {
        group = company;
        out.push(`### ${escMd(company)}`, '');
      }
      out.push(`#### ${escMd(f.title)}`, '');
      for (const [label, value] of [
        ['Title', f.title],
        ['Company', company],
        ['Employment type', f.employment_type],
        ['Dates', f.dates],
        ['Location', f.location]
      ]) {
        const line = fieldLine(label, value);
        if (line) {
          out.push(line);
        }
      }
      const companyUrl = f.company_url || firstLink(item, /\/company\//i);
      if (companyUrl) {
        out.push(fieldLine('Company URL', companyUrl));
      }
      pushDescription(out, f.description);
      out.push('');
    }
    return out;
  }

  function formatSection(section) {
    const key = sectionKey(section);
    if (key === 'experience') {
      return formatExperience(section);
    }
    const out = [];
    if (key === 'skills') {
      const seen = new Set();
      let n = 1;
      for (const item of section.items || []) {
        const skill = recordFields('skills', item).skill;
        const k = norm(skill).toLowerCase();
        if (!skill || seen.has(k)) {
          continue;
        }
        seen.add(k);
        out.push(`${n}. ${escMd(skill)}`);
        n++;
      }
      return out;
    }
    if (key === 'languages') {
      const entries = [];
      const seen = new Set();
      let hasProficiency = false;
      for (const item of section.items || []) {
        const f = recordFields('languages', item);
        const language = norm(f.language);
        const k = language.toLowerCase();
        if (!language || seen.has(k)) {
          continue;
        }
        seen.add(k);
        hasProficiency = hasProficiency || Boolean(norm(f.proficiency));
        entries.push(f);
      }
      if (!hasProficiency) {
        return entries.map((f, index) => `${index + 1}. ${escMd(f.language)}`);
      }
    }
    for (const item of section.items || []) {
      if ((item.depth || 0) > 0) {
        continue;
      }
      const f = recordFields(key, item);
      if (key === 'education' && f.institution) {
        pushRecord(
          out,
          f.institution,
          [
            ['Institution', f.institution],
            ['Degree / field of study', f.degree_and_field],
            ['Dates', f.dates],
            ['Grade', f.grade],
            ['Activities and societies', f.activities]
          ],
          f.description
        );
      } else if (key === 'certifications' && f.certification) {
        pushRecord(
          out,
          f.certification,
          [
            ['Certification', f.certification],
            ['Issuer', f.issuer],
            ['Issued', f.issued],
            ['Expires', f.expires],
            ['Credential ID', f.credential_id],
            ['Credential URL', f.credential_url]
          ],
          f.description
        );
      } else if (key === 'projects' && f.project) {
        pushRecord(
          out,
          f.project,
          [
            ['Project', f.project],
            ['Dates', f.dates],
            ['Associated organisation', f.associated_with],
            ['Project URL', f.project_url]
          ],
          f.description
        );
      } else if (key === 'publications' && f.title) {
        pushRecord(
          out,
          f.title,
          [
            ['Title', f.title],
            ['Publisher', f.publisher],
            ['Published', f.published],
            ['URL', f.url]
          ],
          f.description
        );
      } else if (key === 'patents' && f.patent) {
        pushRecord(
          out,
          f.patent,
          [
            ['Patent', f.patent],
            ['Status', f.status],
            ['Number', f.number],
            ['URL', f.url]
          ],
          f.description
        );
      } else if (key === 'honors' && f.award) {
        pushRecord(
          out,
          f.award,
          [
            ['Award', f.award],
            ['Issuer', f.issuer],
            ['Date', f.date],
            ['Associated with', f.associated_with]
          ],
          f.description
        );
      } else if (key === 'languages' && f.language) {
        pushRecord(
          out,
          f.language,
          [
            ['Language', f.language],
            ['Proficiency', f.proficiency]
          ],
          []
        );
      } else if (key === 'volunteering' && f.role) {
        pushRecord(
          out,
          f.role,
          [
            ['Role', f.role],
            ['Organisation', f.organisation],
            ['Dates', f.dates],
            ['Location', f.location],
            ['Cause', f.cause]
          ],
          f.description
        );
      } else if (key === 'courses' && f.course) {
        pushRecord(
          out,
          f.course,
          [
            ['Course', f.course],
            ['Course number', f.course_number],
            ['Associated with', f.associated_with]
          ],
          f.details
        );
      } else if (key === 'test-scores' && f.test) {
        pushRecord(
          out,
          f.test,
          [
            ['Test', f.test],
            ['Score', f.score],
            ['Date', f.date],
            ['Associated with', f.associated_with],
            ['URL', f.url]
          ],
          f.description
        );
      } else if (key === 'organizations' && f.organisation) {
        pushRecord(
          out,
          f.organisation,
          [
            ['Organisation', f.organisation],
            ['Position', f.position],
            ['Dates', f.dates],
            ['Associated with', f.associated_with]
          ],
          f.description
        );
      } else if (key === 'services' && f.service) {
        pushRecord(out, f.service, [['Service', f.service]], f.details);
      } else if (key === 'causes' && f.cause) {
        pushRecord(out, f.cause, [['Cause', f.cause]], f.details);
      } else {
        const title = f.title || item.title || cleanLines(item)[0] || '';
        const details = f.description || f.details || cleanLines(item).slice(1);
        if (title) {
          pushRecord(out, title, [], details);
        }
      }
    }
    return out;
  }

  function contactSummaryLines(data) {
    const contact = data.contact_info || {};
    const out = [];
    const seen = new Set();
    const add = (label, value) => {
      const v = norm(value);
      const k = `${label}|${v}`.toLowerCase();
      if (!v || seen.has(k)) {
        return;
      }
      seen.add(k);
      out.push([label, v]);
    };
    for (const site of contact.websites || []) {
      add(site.label && !/^website$/i.test(site.label) ? site.label : 'Website', site.url);
    }
    for (const item of contact.items || []) {
      const label = norm(item.label);
      if (!label || /^profile$/i.test(label)) {
        continue;
      }
      let value = norm(item.value);
      if (!value && item.links?.length) {
        value = item.links[0].text || item.links[0].url || '';
      }
      add(label, value);
    }
    return out;
  }

  function buildMarkdown(data) {
    const p = data.top || {};
    const lines = ['## Profile summary', ''];

    const experience = (data.sections || []).find((s) => sectionKey(s) === 'experience');
    const firstRoleItem = (experience?.items || []).find((item) => !item.has_children);
    const firstRole = firstRoleItem ? recordFields('experience', firstRoleItem) : {};
    const summary = [
      ['Name', p.name],
      ['Pronouns', p.pronouns],
      ['Headline', p.headline],
      [
        'Current role',
        p.current_role || (/\bPresent\b/i.test(firstRole.dates || '') ? firstRole.title : '')
      ],
      [
        'Current company',
        p.current_organizations?.[0] ||
          (/\bPresent\b/i.test(firstRole.dates || '') ? firstRole.company : '')
      ],
      ['Location', p.location],
      ['Country / region', p.country || p.region || ''],
      ['Industry', p.industry],
      ['Education summary', (p.education_summary || []).join(' | ')],
      ['Followers', norm(p.followers).replace(/\s+followers?$/i, '')],
      ['Connections', norm(p.connections).replace(/\s+connections?$/i, '')],
      ['LinkedIn profile', data.source_url]
    ];
    for (const [label, value] of summary) {
      const line = fieldLine(label, value);
      if (line) {
        lines.push(line);
      }
    }
    for (const [label, value] of contactSummaryLines(data)) {
      const line = fieldLine(label, value);
      if (line) {
        lines.push(line);
      }
    }

    if (data.about) {
      lines.push('', '## About', '', escMd(data.about), '');
    }

    const preferredOrder = [
      'experience',
      'education',
      'certifications',
      'projects',
      'skills',
      'publications',
      'patents',
      'honors',
      'languages',
      'volunteering',
      'courses',
      'test-scores',
      'organizations',
      'services',
      'causes'
    ];
    const sections = [...(data.sections || [])]
      .filter((s) => ALLOWED_SECTION_KEYS.has(sectionKey(s)))
      .sort(
        (a, b) => preferredOrder.indexOf(sectionKey(a)) - preferredOrder.indexOf(sectionKey(b))
      );
    for (const section of sections) {
      const key = sectionKey(section);
      const body = formatSection(section);
      if (!body.length) {
        continue;
      }
      lines.push('', `## ${SECTION_TITLES[key] || section.title}`, '', ...body);
    }

    while (lines.length && lines.at(-1) === '') {
      lines.pop();
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  function extensionForContentType(contentType, fallbackUrl) {
    const type = String(contentType || '').toLowerCase();
    if (type.includes('avif')) {
      return 'avif';
    }
    if (type.includes('png')) {
      return 'png';
    }
    if (type.includes('webp')) {
      return 'webp';
    }
    if (type.includes('gif')) {
      return 'gif';
    }
    if (type.includes('jpeg') || type.includes('jpg')) {
      return 'jpg';
    }
    const m = String(fallbackUrl || '').match(/\.(png|jpe?g|webp|gif)(?:[?#]|$)/i);
    return m ? m[1].replace('jpeg', 'jpg').toLowerCase() : 'jpg';
  }

  globalThis.LinkedInExportUtils = {
    ALLOWED_SECTION_KEYS,
    SECTION_TITLES,
    sanitizeFilename,
    sectionKey,
    mergeSections,
    applyFallbackText,
    buildMarkdown,
    extensionForContentType,
    countSectionRecords,
    recordFields,
    recordSignature,
    mergeItemArrays
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.LinkedInExportUtils;
  }
})();
