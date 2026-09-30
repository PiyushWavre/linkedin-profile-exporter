(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('honors', (item) => {
    const { parts, date, associated } = c.base(item);
    if (!parts.length) {
      return {};
    }
    const award = parts[0] || '',
      issuedByLine = parts.find((x) => /^Issued by\b/i.test(x)) || '',
      issuedBy = c.splitIssuedBy(issuedByLine),
      issuer =
        issuedBy.issuer ||
        (parts[1] && !c.looksLikeDate(parts[1]) && !/^Associated with\b/i.test(parts[1])
          ? parts[1]
          : ''),
      awardDate = issuedBy.date || (date === issuedByLine ? '' : date);
    return {
      award,
      issuer,
      date: awardDate,
      associated_with: associated.replace(/^Associated with\s*/i, ''),
      description: c.remainingDetails(parts, [award, issuer, issuedByLine, date, associated])
    };
  });
})();
