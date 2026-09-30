(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('languages', (item) => {
    const { parts } = c.base(item);
    return { language: parts[0] || '', proficiency: parts[1] || '' };
  });
})();
