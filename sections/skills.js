(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('skills', (item) => {
    const { parts } = c.base(item);
    return { skill: parts[0] || '' };
  });
})();
