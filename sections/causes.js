(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('causes', (item) => {
    const { parts } = c.base(item);
    if (!parts.length) return {};
    const cause = parts[0] || '';
    return { cause, details: c.remainingDetails(parts, [cause]) };
  });
})();
