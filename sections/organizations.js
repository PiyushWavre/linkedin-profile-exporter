(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('organizations', (item) => {
    const { parts, date, associated } = c.base(item);
    if (!parts.length) return {};
    const organisation = parts[0] || '';
    const position = parts.slice(1).find((line) => line !== date && line !== associated && !c.looksLikeLocation(line)) || '';
    return {
      organisation,
      position,
      dates: date,
      associated_with: associated.replace(/^Associated with\s*/i, ''),
      description: c.remainingDetails(parts, [organisation, position, date, associated])
    };
  });
})();
