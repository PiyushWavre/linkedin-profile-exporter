(() => {
  'use strict';

  const jobId = new URLSearchParams(location.search).get('jobId') || '';
  const body = document.body;
  const utils = globalThis.LinkedInExportUtils;

  const el = (id) => document.getElementById(id);
  const nodes = {
    profileBanner: el('profileBanner'),
    bannerFallback: el('bannerFallback'),
    profilePhoto: el('profilePhoto'),
    profileInitials: el('profileInitials'),
    profileName: el('profileName'),
    profileHeadline: el('profileHeadline'),
    locationRow: el('locationRow'),
    profileLocation: el('profileLocation'),
    companyRow: el('companyRow'),
    profileCompany: el('profileCompany'),
    profileRole: el('profileRole'),
    aboutBlock: el('aboutBlock'),
    profileAbout: el('profileAbout'),
    summaryMetrics: el('summaryMetrics'),
    statusPillText: el('statusPillText'),
    pageTitle: el('pageTitle'),
    pageMessage: el('pageMessage'),
    fileName: el('fileName'),
    fileSize: el('fileSize'),
    fileState: el('fileState'),
    downloadBtn: el('downloadBtn'),
    downloadBtnText: el('downloadBtnText'),
    downloadNotice: el('downloadNotice'),
    downloadNoticeText: el('downloadNoticeText'),
    includedFiles: el('includedFiles'),
    sectionBadge: el('sectionBadge'),
    capturedSections: el('capturedSections')
  };

  let zipBlob = null;
  let zipObjectUrl = '';
  let downloadId;
  let disposed = false;
  const previewObjectUrls = [];

  const send = (type, fields = {}) => chrome.runtime.sendMessage({ type, jobId, ...fields });
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  function setState(state, pill, title, message) {
    body.dataset.state = state;
    if (pill) nodes.statusPillText.textContent = pill;
    if (title) nodes.pageTitle.textContent = title;
    if (message) nodes.pageMessage.textContent = message;
  }

  function setDownloadNotice(message) {
    nodes.downloadNoticeText.textContent = message || '';
    nodes.downloadNotice.hidden = !message;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return 'Ready';
    if (value < 1024) return `${value} B`;
    const kb = value / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    const mb = kb / 1024;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }

  function initials(name) {
    const parts = norm(name).split(' ').filter(Boolean).slice(0, 2);
    return (parts.map((part) => Array.from(part)[0] || '').join('') || 'LP').toUpperCase();
  }

  function currentRole(data) {
    const top = data.top || {};
    const experience = (data.sections || []).find((section) => utils.sectionKey(section) === 'experience');
    const presentItem = (experience?.items || []).find((item) => {
      if (item?.has_children) return false;
      const fields = utils.recordFields('experience', item);
      return /\bPresent\b/i.test(fields.dates || '');
    });
    const fields = presentItem ? utils.recordFields('experience', presentItem) : {};
    return {
      role: norm(top.current_role || fields.title),
      company: norm(top.current_organizations?.[0] || fields.company)
    };
  }

  function profileSectionRows(data) {
    const rows = [{ key: 'main', title: 'Main profile', count: 1 }];
    for (const section of data.sections || []) {
      const key = utils.sectionKey(section);
      if (!utils.ALLOWED_SECTION_KEYS.has(key)) continue;
      const count = utils.countSectionRecords(section);
      if (!count) continue;
      rows.push({ key, title: utils.SECTION_TITLES[key] || section.title || key, count });
    }
    return rows;
  }

  function cleanMetric(value, suffix) {
    return norm(value).replace(new RegExp(`\\s+${suffix}s?$`, 'i'), '');
  }

  function addMetric(value, label) {
    if (!norm(value)) return;
    const card = document.createElement('div');
    card.className = 'summary-metric';
    const valueNode = document.createElement('div');
    valueNode.className = 'summary-metric__value';
    valueNode.textContent = value;
    const labelNode = document.createElement('div');
    labelNode.className = 'summary-metric__label';
    labelNode.textContent = label;
    card.append(valueNode, labelNode);
    nodes.summaryMetrics.append(card);
  }

  function renderProfile(data, sectionRows) {
    const top = data.top || {};
    const name = norm(top.name) || 'LinkedIn profile';
    nodes.profileName.textContent = name;
    nodes.profileInitials.textContent = initials(name);

    const headline = norm(top.headline);
    if (headline) {
      nodes.profileHeadline.textContent = headline;
      nodes.profileHeadline.hidden = false;
    }

    const location = norm(top.location);
    if (location) {
      nodes.profileLocation.textContent = location;
      nodes.locationRow.hidden = false;
    }

    const role = currentRole(data);
    if (role.company || role.role) {
      nodes.profileCompany.textContent = role.company || role.role;
      nodes.profileRole.textContent = role.company && role.role ? role.role : '';
      nodes.companyRow.hidden = false;
    }

    if (norm(data.about)) {
      nodes.profileAbout.textContent = norm(data.about);
      nodes.aboutBlock.hidden = false;
    }

    nodes.summaryMetrics.replaceChildren();
    addMetric(String(sectionRows.length), sectionRows.length === 1 ? 'Section' : 'Sections');
    const connections = cleanMetric(top.connections, 'connection');
    const followers = cleanMetric(top.followers, 'follower');
    if (connections) addMetric(connections, 'Connections');
    if (followers) addMetric(followers, 'Followers');
    nodes.summaryMetrics.style.setProperty('--metric-count', String(nodes.summaryMetrics.childElementCount || 1));
  }

  function iconSvg(kind) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(ns, 'path');
    const paths = {
      document: 'M6 2h8l4 4v16H6V2Zm8 1.8V7h3.2L14 3.8ZM8 10v2h8v-2H8Zm0 4v2h8v-2H8Zm0 4v2h6v-2H8Z',
      image: 'M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v11.5l4.5-4.5 3 3 2-2 6.5 6V5H4Zm4 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
      profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9v-2a7 7 0 0 1 14 0v2H5Z'
    };
    path.setAttribute('d', paths[kind] || paths.document);
    svg.append(path);
    return svg;
  }

  function addIncludedItem(kind, title, subtitle) {
    const row = document.createElement('div');
    row.className = 'included-item';
    const icon = document.createElement('div');
    icon.className = 'included-icon';
    icon.append(iconSvg(kind));
    const copy = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = title;
    const span = document.createElement('span');
    span.textContent = subtitle;
    copy.append(strong, span);
    row.append(icon, copy);
    nodes.includedFiles.append(row);
  }

  function renderIncludedFiles({ profileImageIncluded, bannerImageIncluded }) {
    nodes.includedFiles.replaceChildren();
    addIncludedItem('document', 'Profile details (Markdown)', 'Captured profile data in a clean Markdown file');
    if (profileImageIncluded) addIncludedItem('image', 'Profile picture', 'Included as a JPEG image');
    if (bannerImageIncluded) addIncludedItem('image', 'Banner image', 'Included as a JPEG image');
  }

  function sectionShortCode(key) {
    const labels = {
      main: 'P', experience: 'E', education: 'ED', certifications: 'C', projects: 'PR', skills: 'S',
      publications: 'PB', patents: 'PT', honors: 'H', languages: 'L', volunteering: 'V', courses: 'CO',
      'test-scores': 'T', organizations: 'O', services: 'SV', causes: 'CA'
    };
    return labels[key] || '•';
  }

  function renderSections(rows) {
    nodes.capturedSections.replaceChildren();
    nodes.sectionBadge.textContent = `${rows.length} ${rows.length === 1 ? 'section' : 'sections'}`;
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = 'section-row';
      const icon = document.createElement('span');
      icon.className = 'section-row__icon';
      icon.textContent = sectionShortCode(row.key);
      const name = document.createElement('span');
      name.className = 'section-row__name';
      name.textContent = row.title;
      const count = document.createElement('span');
      count.className = 'section-row__count';
      count.textContent = String(row.count);
      item.append(icon, name, count);
      nodes.capturedSections.append(item);
    }
  }

  async function fetchPreviewImage(url, target, fallback, label, zip) {
    if (!url) return { included: false, warning: `${label}: not present on the profile` };
    try {
      const { bytes, contentType } = await globalThis.LinkedInImages.fetchBinary(url);
      const jpeg = await globalThis.LinkedInImages.toJpeg(bytes, contentType);
      zip.add(`${label}.jpg`, jpeg);
      const objectUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
      previewObjectUrls.push(objectUrl);
      target.src = objectUrl;
      target.hidden = false;
      if (fallback) fallback.hidden = true;
      return { included: true, warning: '' };
    } catch (error) {
      return {
        included: false,
        warning: `${label}: ${error.name === 'AbortError' ? 'image request timed out' : error.message || 'could not read image'}`
      };
    }
  }

  function releaseZipUrl() {
    if (zipObjectUrl) URL.revokeObjectURL(zipObjectUrl);
    zipObjectUrl = '';
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeat);
    releaseZipUrl();
    for (const url of previewObjectUrls.splice(0)) URL.revokeObjectURL(url);
  }

  const heartbeat = setInterval(() => {
    send('DOWNLOAD_HEARTBEAT').catch(() => {});
  }, 20000);

  window.addEventListener('pagehide', dispose, { once: true });

  async function beginDownload() {
    if (!zipBlob || !zipObjectUrl || Number.isInteger(downloadId)) return;

    nodes.downloadBtn.disabled = true;
    nodes.downloadBtnText.textContent = 'Starting download…';
    nodes.fileState.textContent = 'Waiting for Chrome';
    setDownloadNotice('');

    try {
      downloadId = await chrome.downloads.download({
        url: zipObjectUrl,
        filename: nodes.fileName.textContent,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      if (!Number.isInteger(downloadId)) throw new Error('Chrome did not accept the download.');

      const response = await send('EXPORT_DOWNLOAD_STARTED', { downloadId });
      if (!response?.ok) throw new Error(response?.error || 'Could not confirm the download.');

      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item?.state === 'complete') {
        nodes.downloadBtnText.textContent = 'Saved';
        nodes.fileState.textContent = 'Saved';
        setState('ready', 'Export saved', 'Your LinkedIn profile is saved', 'The ZIP was saved successfully. This export window will close automatically.');
        setTimeout(() => window.close(), 1200);
      } else if (item?.state === 'interrupted') {
        throw new Error(item.error || 'Download interrupted.');
      } else {
        nodes.downloadBtnText.textContent = 'Waiting for Chrome…';
      }
    } catch (error) {
      downloadId = undefined;
      nodes.downloadBtn.disabled = false;
      nodes.downloadBtnText.textContent = 'Download ZIP';
      nodes.fileState.textContent = 'Ready to retry';
      setState('retry', 'Ready to retry', 'Your LinkedIn profile is ready', 'The export is still available. Use Download ZIP to try saving it again.');
      setDownloadNotice(error.message || 'Chrome could not start the download.');
    }
  }

  nodes.downloadBtn.addEventListener('click', () => beginDownload());

  chrome.downloads.onChanged.addListener((delta) => {
    if (!Number.isInteger(downloadId) || delta.id !== downloadId) return;

    if (delta.state?.current === 'complete') {
      nodes.downloadBtn.disabled = true;
      nodes.downloadBtnText.textContent = 'Saved';
      nodes.fileState.textContent = 'Saved';
      setState('ready', 'Export saved', 'Your LinkedIn profile is saved', 'The ZIP was saved successfully. This export window will close automatically.');
      setTimeout(() => window.close(), 1200);
      return;
    }

    if (delta.state?.current === 'interrupted') {
      const reason = delta.error?.current || 'Download interrupted';
      downloadId = undefined;
      nodes.downloadBtn.disabled = false;
      nodes.downloadBtnText.textContent = 'Download ZIP';
      nodes.fileState.textContent = 'Ready to retry';
      setState('retry', 'Export still ready', 'Your LinkedIn profile is ready', 'The export is still available on this page. You can download the same ZIP again without recapturing the profile.');
      setDownloadNotice(
        reason === 'USER_CANCELED'
          ? 'Save was cancelled. Nothing was lost. Choose Download ZIP whenever you’re ready.'
          : `Chrome interrupted the download (${reason}). Choose Download ZIP to try again.`
      );
    }
  });

  (async () => {
    try {
      if (!jobId) throw new Error('Export job ID is missing.');

      const payload = await send('GET_FINAL_EXPORT_DATA');
      if (!payload?.ok || !payload.data) throw new Error(payload?.error || 'Captured data is unavailable.');

      const data = payload.data;
      const sectionRows = profileSectionRows(data);
      renderProfile(data, sectionRows);
      renderSections(sectionRows);

      const profileName = utils.sanitizeFilename(data.top?.name || 'LinkedIn-Profile');
      const exportFilename = `${profileName}-LinkedIn-Export.zip`;
      nodes.fileName.textContent = exportFilename;

      const zip = new globalThis.SimpleZip();
      zip.add(`${profileName}.md`, utils.buildMarkdown(data));

      const [profileResult, bannerResult] = await Promise.all([
        fetchPreviewImage(data.images?.profile?.url || '', nodes.profilePhoto, nodes.profileInitials, 'Profile-Picture', zip),
        fetchPreviewImage(data.images?.banner?.url || '', nodes.profileBanner, nodes.bannerFallback, 'Banner-Image', zip)
      ]);

      renderIncludedFiles({
        profileImageIncluded: profileResult.included,
        bannerImageIncluded: bannerResult.included
      });

      zipBlob = zip.blob();
      zipObjectUrl = URL.createObjectURL(zipBlob);
      nodes.fileSize.textContent = formatBytes(zipBlob.size);
      nodes.fileState.textContent = 'Ready to download';
      nodes.downloadBtn.disabled = false;
      nodes.downloadBtnText.textContent = 'Download ZIP';

      setState(
        'ready',
        'Export ready',
        'Your LinkedIn profile is ready',
        'Your profile data and available images have been packaged into a ZIP file.'
      );

      const imageWarnings = [profileResult.warning, bannerResult.warning].filter(Boolean);
      if (imageWarnings.length && imageWarnings.length < 2) {
        setDownloadNotice('One profile image was unavailable, so the ZIP contains the data and the image that could be captured.');
      }

    } catch (error) {
      setState('retry', 'Export needs attention', 'The export could not be prepared', 'Return to the LinkedIn profile and run the export again.');
      nodes.fileState.textContent = 'Unavailable';
      nodes.downloadBtn.disabled = true;
      nodes.downloadBtnText.textContent = 'Download unavailable';
      setDownloadNotice(error.message || 'The export could not be prepared.');
      await send('EXPORT_DOWNLOAD_FAILED', { error: error.message || 'Export preparation failed.' }).catch(() => {});
    }
  })();
})();
