(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('education', (item) => {
    const { parts, date } = c.base(item);
    if (!parts.length) {
      return {};
    }
    const institution = parts[0] || '',
      degree = parts[1] && !c.looksLikeDate(parts[1]) ? parts[1] : '',
      grade = parts.find((x) => /^Grade\b/i.test(x)) || '',
      activities = parts.find((x) => /^Activities and societies\b/i.test(x)) || '';
    return {
      institution,
      degree_and_field: degree,
      dates: date,
      grade,
      activities,
      description: c.remainingDetails(parts, [institution, degree, date, grade, activities])
    };
  });
})();
