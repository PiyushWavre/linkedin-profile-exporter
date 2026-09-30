(() => {
  'use strict';
  function compactCanonical(canonical) {
    if (!canonical?.fields) {
      return canonical || null;
    }
    return {
      schema: canonical.schema || 'linkedin-section-record-v1',
      section_key: canonical.section_key || '',
      record_id: canonical.record_id || '',
      fields: canonical.fields,
      validation: canonical.validation || { valid: true, missing_fields: [], warnings: [] },
      provenance: Object.fromEntries(
        Object.entries(canonical.provenance || {}).map(([key, value]) => [
          key,
          {
            source_kind: value?.source_kind || 'unknown',
            priority: value?.priority || 0,
            confidence: value?.confidence || 0
          }
        ])
      )
    };
  }

  function slimItem(item) {
    if (!item) {
      return item;
    }
    const out = {};
    if (Number(item.depth || 0)) {
      out.depth = Number(item.depth || 0);
    }
    if (item.has_children) {
      out.has_children = true;
    }
    if (item.group) {
      out.group = item.group;
    }
    if (item.canonical) {
      out.canonical = compactCanonical(item.canonical);
    } else {
      if (item.title) {
        out.title = item.title;
      }
      if (item.subtitle) {
        out.subtitle = item.subtitle;
      }
      if (Array.isArray(item.details) && item.details.length) {
        out.details = item.details;
      }
      if (Array.isArray(item.lines) && item.lines.length) {
        out.lines = item.lines;
      }
      if (Array.isArray(item.links) && item.links.length) {
        out.links = item.links;
      }
    }
    return out;
  }

  function slimSection(section) {
    if (!section) {
      return section;
    }
    const out = { ...section };
    delete out.raw_text;
    delete out.rendered_text_snapshot;
    delete out.links;
    delete out.extraction;
    if (Array.isArray(out.items)) {
      out.items = out.items.map(slimItem);
    }
    return out;
  }

  function slimProfileData(data) {
    if (!data) {
      return data;
    }
    const out = { ...data };
    delete out.rendered_text_snapshot;
    out.sections = (data.sections || []).map(slimSection);
    if (out.contact_info) {
      out.contact_info = { ...out.contact_info };
      delete out.contact_info.raw_text;
    }
    return out;
  }

  globalThis.LinkedInCaptureData = { slimProfileData, slimSection };
})();
