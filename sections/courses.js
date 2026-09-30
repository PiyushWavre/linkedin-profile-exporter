(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('courses', (item) => {
    const { parts, associated } = c.base(item);
    if (!parts.length) {
      return {};
    }
    const course = parts[0] || '',
      courseNumber =
        parts.find(
          (x, i) =>
            i > 0 && /^(?:Course\s*(?:No\.?|Number)\s*[:#-]?\s*)?[A-Z]{1,8}[- ]?\d{2,6}$/i.test(x)
        ) || '';
    return {
      course,
      course_number: courseNumber,
      associated_with: associated.replace(/^Associated with\s*/i, ''),
      details: c.remainingDetails(parts, [course, courseNumber, associated])
    };
  });
})();
