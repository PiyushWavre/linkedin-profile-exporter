(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('services', (item) => {
    const { parts } = c.base(item);
    if (!parts.length) return {};
    const service = parts[0] || '';
    return { service, details: c.remainingDetails(parts, [service]) };
  });
})();
