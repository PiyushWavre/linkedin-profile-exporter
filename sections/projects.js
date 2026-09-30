(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('projects', (item) => {
    const { parts, date, associated } = c.base(item);
    if (!parts.length) {
      return {};
    }
    const project = parts[0] || '';
    return {
      project,
      dates: date,
      associated_with: associated.replace(/^Associated with\s*/i, ''),
      project_url: c.firstLink(item),
      description: c.remainingDetails(parts, [project, date, associated])
    };
  });
})();
