(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('experience', (item) => {
    const { parts, date } = c.base(item);
    if (!parts.length) {
      return {};
    }
    if (item?.has_children && (item.depth || 0) === 0) {
      return {
        record_type: 'company_group',
        company: parts[0],
        overall_duration: parts[1] || '',
        details: parts.slice(2)
      };
    }
    const title = parts[0] || '';
    let company = item?.group || '',
      employment_type = '';
    let companyLine = '';
    if (!company && parts[1] && !c.looksLikeDate(parts[1]) && !c.looksLikeLocation(parts[1])) {
      ({ company, employment_type } = c.splitCompanyEmployment(parts[1]));
      companyLine = parts[1];
    }
    const location = c.findExperienceLocation(parts, date);
    return {
      record_type: 'role',
      title,
      company,
      employment_type,
      dates: date,
      location,
      company_url: c.firstLink(item, /\/company\//i),
      description: c.remainingDetails(parts, [title, companyLine, date, location])
    };
  });
})();
