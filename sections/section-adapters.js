(() => {
  'use strict';
  const model = globalThis.LinkedInProfileModel;
  const c = globalThis.LinkedInSectionCommon;
  const parsers = globalThis.LinkedInSectionParsers || new Map();
  function parseFields(key, item) {
    const parser = parsers.get(key);
    if (parser) {
      return parser(item) || {};
    }
    const parts = c?.cleanLines(item) || [];
    return { title: parts[0] || '', details: parts.slice(1), url: c?.firstLink(item) || '' };
  }
  function attachCanonical(key, item, options = {}) {
    if (!item) {
      return item;
    }
    const fields = parseFields(key, item);
    const canonical = model?.createCanonicalRecord
      ? model.createCanonicalRecord(key, fields, {
          ...options,
          evidence_lines: Array.isArray(item.lines) ? item.lines : c?.cleanLines(item) || [],
          links: item.links || []
        })
      : {
          section_key: key,
          fields,
          provenance: {},
          validation: { valid: true, missing_fields: [], warnings: [] }
        };
    return { ...item, canonical };
  }
  function fields(key, item) {
    return item?.canonical?.fields || parseFields(key, item);
  }
  function signature(key, item) {
    const f = fields(key, item);
    return model?.stableIdentity
      ? model.stableIdentity(key, f)
      : (c?.cleanLines(item) || []).slice(0, 4).join('|').toLowerCase();
  }
  function identity(key, item) {
    const f = fields(key, item);
    return model?.matchIdentity ? model.matchIdentity(key, f) : signature(key, item);
  }
  const adapters = {};
  for (const key of parsers.keys()) {
    adapters[key] = {
      key,
      parse: (item, opts = {}) => attachCanonical(key, item, opts),
      fields: (item) => fields(key, item),
      signature: (item) => signature(key, item),
      identity: (item) => identity(key, item)
    };
  }
  globalThis.LinkedInSectionAdapters = {
    adapters,
    cleanLines: c?.cleanLines,
    parseFields,
    attachCanonical,
    fields,
    signature,
    identity,
    looksLikeDate: c?.looksLikeDate,
    looksLikeLocation: c?.looksLikeLocation
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.LinkedInSectionAdapters;
  }
})();
