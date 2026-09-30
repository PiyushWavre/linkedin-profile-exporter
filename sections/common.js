(() => {
  'use strict';
  const parsers = globalThis.LinkedInSectionParsers || new Map();

  function norm(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\r/g, '')
      .trim();
  }
  function cleanLines(item) {
    const raw = Array.isArray(item?.lines) ? item.lines : String(item?.text || '').split('\n');
    const seen = new Set();
    const out = [];
    for (const part of raw) {
      const value = norm(part);
      if (
        !value ||
        /^(?:show all.*|show credential|see credential|see more|show more|back|close|edit|add)$/i.test(
          value
        )
      ) {
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
  function looksLikeDate(line) {
    const text = norm(line).replace(/^(?:Issued|Expires?)(?: on)?\s+/i, '');
    return (
      /^(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+)?(?:19|20)\d{2}(?:\s*(?:[-–—·]|to)\s*.+)?$/i.test(
        text
      ) ||
      /^\d+\s+(?:yrs?|years?|mos?|months?)(?:\s+\d+\s+(?:mos?|months?))?$/i.test(text) ||
      /^Present$/i.test(text)
    );
  }
  function looksLikeLocation(line) {
    const value = norm(line);
    if (!value || value.length > 120) {
      return false;
    }
    if (/\b(?:On-site|Hybrid|Remote)\b/i.test(value)) {
      return true;
    }
    if (/\b(?:Area|Region|Metropolitan|District|Province|State|County)\b/i.test(value)) {
      return true;
    }
    if (
      /\b(?:India|United States|USA|United Kingdom|UK|Singapore|UAE|United Arab Emirates|Canada|Australia|Germany|France|Japan)\b/i.test(
        value
      )
    ) {
      return true;
    }
    if ((value.match(/,/g) || []).length >= 2) {
      return true;
    }
    if (/,/.test(value)) {
      if (
        /\b(?:audit|documentation|client|business development|procurement|strategy|marketing|sales|operations|technology|project|skills?)\b/i.test(
          value
        )
      ) {
        return false;
      }
      return value.split(',').every((part) => norm(part).length > 0 && norm(part).length < 55);
    }
    return false;
  }
  function splitIssuedExpiry(value) {
    const result = { issued: '', expires: '' };
    for (const segment of norm(value).split(/\s+·\s+/)) {
      if (/^Issued\b/i.test(segment)) {
        result.issued = segment.replace(/^Issued\s*/i, '');
      } else if (/^Expires?\b/i.test(segment)) {
        result.expires = segment.replace(/^Expires?\s*/i, '');
      }
    }
    return result;
  }
  function splitIssuedBy(value) {
    const text = norm(value);
    const m = text.match(/^Issued by\s+(.+?)(?:\s+·\s+(.+))?$/i);
    return m ? { issuer: norm(m[1]), date: norm(m[2]) } : { issuer: '', date: '' };
  }
  function findExperienceLocation(parts, date) {
    const afterDateIndex = date ? parts.findIndex((line) => line === date) : 1;
    const candidates = parts.slice(Math.max(1, afterDateIndex + 1));
    return candidates.find(looksLikeLocation) || '';
  }
  function linksOf(item) {
    const seen = new Set();
    return (item?.links || []).filter((link) => {
      const url = String(link?.url || '').trim();
      if (
        !globalThis.LinkedInRuntime.safeLink(url) ||
        seen.has(url) ||
        /\/edit(?:\/|$)/i.test(url)
      ) {
        return false;
      }
      seen.add(url);
      return true;
    });
  }
  function firstLink(item, rx = null) {
    const links = linksOf(item);
    const found = rx ? links.find((l) => rx.test(`${l.text || ''} ${l.url || ''}`)) : links[0];
    return found?.url || '';
  }
  function splitCompanyEmployment(value) {
    const parts = norm(value)
      .split(/\s+·\s+/)
      .filter(Boolean);
    if (parts.length <= 1) {
      return { company: norm(value), employment_type: '' };
    }
    const employmentRx =
      /^(?:Full-time|Part-time|Contract|Internship|Freelance|Self-employed|Apprenticeship|Seasonal|Temporary)$/i;
    return {
      company: parts[0] || '',
      employment_type: parts.find((p) => employmentRx.test(p)) || ''
    };
  }
  function remainingDetails(parts, consumed) {
    const used = new Set((consumed || []).filter(Boolean).map((v) => norm(v).toLowerCase()));
    return parts.filter((line, index) => index > 0 && !used.has(norm(line).toLowerCase()));
  }
  function base(item) {
    const parts = cleanLines(item);
    return {
      parts,
      date: parts.slice(1).find(looksLikeDate) || '',
      associated: parts.slice(1).find((line) => /^Associated with\b/i.test(line)) || ''
    };
  }
  function register(key, parse) {
    parsers.set(key, parse);
  }

  globalThis.LinkedInSectionParsers = parsers;
  globalThis.LinkedInSectionCommon = {
    norm,
    cleanLines,
    looksLikeDate,
    looksLikeLocation,
    splitIssuedExpiry,
    splitIssuedBy,
    findExperienceLocation,
    linksOf,
    firstLink,
    splitCompanyEmployment,
    remainingDetails,
    base,
    register
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.LinkedInSectionCommon;
  }
})();
