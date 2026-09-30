(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('volunteering', (item) => {
    const { parts, date } = c.base(item);
    if (!parts.length) {
      return {};
    }
    const role = parts[0] || '',
      organisation = parts[1] && !c.looksLikeDate(parts[1]) ? parts[1] : '',
      causeLine =
        parts.find((x) => /^Cause\b/i.test(x)) ||
        parts.find((x) =>
          /^(?:Social Services|Education|Environment|Health|Human Rights|Disaster and Humanitarian Relief|Children|Arts and Culture|Animal Welfare|Civil Rights and Social Action|Economic Empowerment|Politics|Poverty Alleviation|Science and Technology)$/i.test(
            x
          )
        ) ||
        '',
      location =
        parts.slice(2).find((x) => x !== date && x !== causeLine && c.looksLikeLocation(x)) || '';
    return {
      role,
      organisation,
      dates: date,
      location,
      cause: causeLine.replace(/^Cause\s*[:·-]?\s*/i, ''),
      description: c.remainingDetails(parts, [role, organisation, date, location, causeLine])
    };
  });
})();
