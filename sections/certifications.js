(() => {
  const c = globalThis.LinkedInSectionCommon;
  c.register('certifications', (item) => {
    const { parts } = c.base(item);
    if (!parts.length) {
      return {};
    }
    const certification = parts[0] || '',
      issuer = parts[1] && !/^Issued\b|^Expires?\b|^Credential\b/i.test(parts[1]) ? parts[1] : '',
      issuedLine = parts.find((x) => /^Issued\b/i.test(x)) || '',
      expiresLine = parts.find((x) => /^Expires?\b/i.test(x)) || '',
      combined = c.splitIssuedExpiry(issuedLine),
      issued = combined.issued || issuedLine.replace(/^Issued\s*/i, ''),
      expires = combined.expires || expiresLine.replace(/^Expires?\s*/i, ''),
      credential = parts.find((x) => /^Credential ID\b/i.test(x)) || '';
    return {
      certification,
      issuer,
      issued,
      expires,
      credential_id: credential.replace(/^Credential ID\s*[:·-]?\s*/i, ''),
      credential_url: c.firstLink(item, /credential|certificate/i),
      description: c.remainingDetails(parts, [
        certification,
        issuer,
        issuedLine,
        expiresLine,
        credential
      ])
    };
  });
})();
