(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('patents', (item) => {
    const { parts } = c.base(item);
    if (!parts.length) return {};
    const patent = parts[0] || '';
    const status = parts.find((line) => /^(?:Issued|Filed|Published|Granted)\b/i.test(line)) || '';
    const number = parts.find((line) => /\b(?:US|EP|WO|IN|CN|JP|GB)?\s*[A-Z]?\s*\d{5,}[A-Z0-9\s-]*$/i.test(line)) || '';
    return {
      patent,
      status,
      number,
      url: c.firstLink(item),
      description: c.remainingDetails(parts, [patent, status, number])
    };
  });
})();
