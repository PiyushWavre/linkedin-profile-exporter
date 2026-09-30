(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('publications', (item) => {
    const { parts, date } = c.base(item);
    if (!parts.length) {
      return {};
    }
    const title = parts[0] || '',
      publisher = parts[1] && !c.looksLikeDate(parts[1]) ? parts[1] : '';
    return {
      title,
      publisher,
      published: date,
      url: c.firstLink(item),
      description: c.remainingDetails(parts, [title, publisher, date])
    };
  });
})();
