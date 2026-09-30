(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('test-scores', (item) => {
    const { parts, date, associated } = c.base(item);
    if (!parts.length) {
      return {};
    }
    const test = parts[0] || '',
      scoreLine =
        parts.find((x, i) => i > 0 && /^Score\b/i.test(x)) ||
        (parts[1] && !c.looksLikeDate(parts[1]) ? parts[1] : ''),
      m = c
        .norm(scoreLine)
        .match(/^Score\s*[:·-]?\s*(?:Score\s*[:·-]?\s*)?(.+?)(?:\s+·\s+(.+))?$/i),
      score = m ? c.norm(m[1]) : c.norm(scoreLine).replace(/^Score\s*[:·-]?\s*/i, ''),
      scoreDate = m?.[2] && c.looksLikeDate(m[2]) ? c.norm(m[2]) : date,
      urlLine = parts.find((x) => /^https?:\/\//i.test(x)) || c.firstLink(item);
    return {
      test,
      score,
      date: scoreDate,
      associated_with: associated.replace(/^Associated with\s*/i, ''),
      url: urlLine,
      description: c.remainingDetails(parts, [test, scoreLine, date, associated, urlLine])
    };
  });
})();
