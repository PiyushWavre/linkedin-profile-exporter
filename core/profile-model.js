(() => {
  'use strict';

  const SCHEMA_VERSION = 'linkedin-career-profile-v2';
  const RECORD_SCHEMA_VERSION = 'linkedin-section-record-v1';

  const SOURCE_PRIORITY = Object.freeze({
    'viewport-dom': 500,
    'detail-viewport-dom': 520,
    'profile-viewport-dom': 510,
    'single-pass-rendered-text': 250,
    'source-text': 150,
    unknown: 0
  });

  // Only the record's identity field(s) are required. All other LinkedIn fields
  // are optional supporting data: capture them when present, never reject a
  // record only because LinkedIn left them blank.
  const PRIMARY_FIELDS = Object.freeze({
    experience: ['title', 'company'],
    education: ['institution'],
    certifications: ['certification'],
    projects: ['project'],
    skills: ['skill'],
    publications: ['title'],
    patents: ['patent'],
    honors: ['award'],
    languages: ['language'],
    volunteering: ['role'],
    courses: ['course'],
    'test-scores': ['test'],
    organizations: ['organisation'],
    services: ['service'],
    causes: ['cause']
  });

  const ARRAY_FIELDS = new Set(['description', 'details']);

  function norm(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\r/g, '')
      .trim();
  }

  function isEmpty(value) {
    if (Array.isArray(value)) {
      return value.length === 0;
    }
    return !norm(value);
  }

  function normalizeValue(value) {
    if (Array.isArray(value)) {
      const out = [];
      const seen = new Set();
      for (const entry of value) {
        const clean = norm(entry);
        if (!clean) {
          continue;
        }
        const key = clean.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push(clean);
      }
      return out;
    }
    if (value && typeof value === 'object') {
      return value;
    }
    return norm(value);
  }

  function sourcePriority(kind) {
    return SOURCE_PRIORITY[kind] ?? SOURCE_PRIORITY.unknown;
  }

  function confidenceFor(kind) {
    const priority = sourcePriority(kind);
    if (priority >= 500) {
      return 0.98;
    }
    if (priority >= 400) {
      return 0.92;
    }
    if (priority >= 300) {
      return 0.82;
    }
    if (priority >= 225) {
      return 0.72;
    }
    if (priority >= 200) {
      return 0.66;
    }
    if (priority >= 125) {
      return 0.55;
    }
    return 0.4;
  }

  function makeFieldProvenance(field, value, options = {}) {
    const sourceKind = options.source_kind || options.sourceKind || 'unknown';
    return {
      field,
      source_kind: sourceKind,
      source_scope: options.source_scope || options.sourceScope || '',
      source_url: options.source_url || options.sourceUrl || '',
      captured_at: options.captured_at || options.capturedAt || new Date().toISOString(),
      confidence: Number(options.confidence ?? confidenceFor(sourceKind)),
      priority: Number(options.priority ?? sourcePriority(sourceKind)),
      evidence_lines: Array.isArray(options.evidence_lines)
        ? options.evidence_lines.map(norm).filter(Boolean).slice(0, 12)
        : [],
      value_preview: Array.isArray(value)
        ? value.slice(0, 3).join(' | ')
        : norm(value).slice(0, 220)
    };
  }

  function validate(sectionKey, fields) {
    const required =
      sectionKey === 'experience' && fields?.record_type === 'company_group'
        ? ['company']
        : PRIMARY_FIELDS[sectionKey] || [];
    const missing = required.filter((name) => isEmpty(fields?.[name]));
    const warnings = [];
    return { valid: missing.length === 0, missing_fields: missing, warnings };
  }

  function stableIdentity(sectionKey, fields) {
    const f = fields || {};
    const partsBySection = {
      experience: [f.record_type, f.company, f.title, f.dates, f.overall_duration],
      education: [f.institution, f.degree_and_field, f.dates],
      certifications: [f.certification, f.issuer, f.issued],
      projects: [f.project, f.dates, f.associated_with],
      skills: [f.skill],
      publications: [f.title, f.publisher, f.published],
      patents: [f.patent, f.status, f.number],
      honors: [f.award, f.issuer, f.date],
      languages: [f.language, f.proficiency],
      volunteering: [f.role, f.organisation, f.dates],
      courses: [f.course, f.course_number, f.associated_with],
      'test-scores': [f.test, f.score, f.date],
      organizations: [f.organisation, f.position, f.dates],
      services: [f.service],
      causes: [f.cause]
    };
    const parts = partsBySection[sectionKey] || Object.values(f).slice(0, 4);
    return parts
      .map((value) => (Array.isArray(value) ? value.join(' ') : norm(value)))
      .filter(Boolean)
      .join('|')
      .toLowerCase();
  }

  function matchIdentity(sectionKey, fields) {
    const f = fields || {};
    const partsBySection = {
      experience:
        f.record_type === 'company_group'
          ? [f.record_type, f.company]
          : [f.record_type, f.company, f.title, f.dates],
      education: [f.institution, f.degree_and_field, f.dates],
      certifications: [f.certification, f.issuer, f.issued],
      projects: [f.project, f.dates],
      skills: [f.skill],
      publications: [f.title, f.publisher, f.published],
      patents: [f.patent, f.status, f.number],
      honors: [f.award, f.issuer, f.date],
      languages: [f.language],
      volunteering: [f.role, f.organisation, f.dates],
      courses: [f.course, f.course_number, f.associated_with],
      'test-scores': [f.test, f.date],
      organizations: [f.organisation, f.position, f.dates],
      services: [f.service],
      causes: [f.cause]
    };
    const parts = partsBySection[sectionKey] || Object.values(f).slice(0, 2);
    return parts
      .map((value) => (Array.isArray(value) ? value.join(' ') : norm(value)))
      .filter(Boolean)
      .join('|')
      .toLowerCase();
  }

  function createCanonicalRecord(sectionKey, fields, options = {}) {
    const cleanFields = {};
    for (const [name, value] of Object.entries(fields || {})) {
      const clean = normalizeValue(value);
      if (isEmpty(clean)) {
        continue;
      }
      if (['__proto__', 'constructor', 'prototype'].includes(name)) {
        continue;
      }
      cleanFields[name] = clean;
    }
    const provenance = {};
    for (const [field, value] of Object.entries(cleanFields)) {
      provenance[field] = makeFieldProvenance(field, value, options);
    }
    const validation = validate(sectionKey, cleanFields);
    return {
      schema: RECORD_SCHEMA_VERSION,
      section_key: sectionKey,
      record_id: stableIdentity(sectionKey, cleanFields),
      fields: cleanFields,
      provenance,
      validation,
      evidence: {
        lines: Array.isArray(options.evidence_lines)
          ? options.evidence_lines.map(norm).filter(Boolean)
          : [],
        links: Array.isArray(options.links) ? options.links : [],
        source_kind: options.source_kind || options.sourceKind || 'unknown',
        source_scope: options.source_scope || options.sourceScope || '',
        source_url: options.source_url || options.sourceUrl || ''
      }
    };
  }

  function provenanceScore(meta) {
    if (!meta) {
      return 0;
    }
    return (
      Number(meta.priority ?? sourcePriority(meta.source_kind)) + Number(meta.confidence || 0) * 10
    );
  }

  function mergeArrays(a, b) {
    const out = [];
    const seen = new Set();
    for (const value of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
      const clean = norm(value);
      if (!clean) {
        continue;
      }
      const key = clean.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(clean);
    }
    return out;
  }

  function reconcileCanonical(primary, incoming) {
    if (!primary) {
      return incoming || null;
    }
    if (!incoming) {
      return primary;
    }
    if (primary.section_key !== incoming.section_key) {
      return primary;
    }

    const fields = { ...(primary.fields || {}) };
    const provenance = { ...(primary.provenance || {}) };
    const decisions = [];

    for (const [field, incomingValue] of Object.entries(incoming.fields || {})) {
      if (isEmpty(incomingValue)) {
        continue;
      }
      const currentValue = fields[field];
      if (ARRAY_FIELDS.has(field)) {
        const merged = mergeArrays(currentValue, incomingValue);
        if (merged.length) {
          fields[field] = merged;
        }
        if (
          !provenance[field] ||
          provenanceScore(incoming.provenance?.[field]) > provenanceScore(provenance[field])
        ) {
          provenance[field] = incoming.provenance?.[field] || provenance[field];
        }
        continue;
      }
      if (isEmpty(currentValue)) {
        fields[field] = incomingValue;
        provenance[field] = incoming.provenance?.[field];
        decisions.push({
          field,
          decision: 'filled-missing',
          source_kind: incoming.provenance?.[field]?.source_kind || ''
        });
        continue;
      }
      if (norm(currentValue).toLowerCase() === norm(incomingValue).toLowerCase()) {
        continue;
      }
      const currentScore = provenanceScore(provenance[field]);
      const incomingScore = provenanceScore(incoming.provenance?.[field]);
      if (incomingScore > currentScore) {
        decisions.push({
          field,
          decision: 'replaced-lower-priority',
          from: provenance[field]?.source_kind || '',
          to: incoming.provenance?.[field]?.source_kind || ''
        });
        fields[field] = incomingValue;
        provenance[field] = incoming.provenance?.[field];
      } else {
        decisions.push({
          field,
          decision: 'kept-higher-priority',
          kept: provenance[field]?.source_kind || '',
          ignored: incoming.provenance?.[field]?.source_kind || ''
        });
      }
    }

    const validation = validate(primary.section_key, fields);
    return {
      ...primary,
      record_id: stableIdentity(primary.section_key, fields),
      fields,
      provenance,
      validation,
      evidence: {
        ...(primary.evidence || {}),
        alternate_sources: [
          ...new Set(
            [
              primary.evidence?.source_kind,
              incoming.evidence?.source_kind,
              ...(primary.evidence?.alternate_sources || []),
              ...(incoming.evidence?.alternate_sources || [])
            ].filter(Boolean)
          )
        ],
        reconciliation: [
          ...(primary.evidence?.reconciliation || []),
          ...(incoming.evidence?.reconciliation || []),
          ...decisions
        ]
      }
    };
  }

  function recordFields(item) {
    return item?.canonical?.fields || {};
  }

  globalThis.LinkedInProfileModel = {
    SCHEMA_VERSION,
    RECORD_SCHEMA_VERSION,
    SOURCE_PRIORITY,
    PRIMARY_FIELDS,
    sourcePriority,
    confidenceFor,
    makeFieldProvenance,
    createCanonicalRecord,
    reconcileCanonical,
    validate,
    stableIdentity,
    matchIdentity,
    recordFields
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.LinkedInProfileModel;
  }
})();
