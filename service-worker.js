'use strict';

importScripts(
  'core/runtime.js',
  'core/profile-model.js',
  'sections/common.js',
  'sections/experience.js',
  'sections/education.js',
  'sections/certifications.js',
  'sections/projects.js',
  'sections/skills.js',
  'sections/publications.js',
  'sections/patents.js',
  'sections/honors.js',
  'sections/languages.js',
  'sections/volunteering.js',
  'sections/courses.js',
  'sections/test-scores.js',
  'sections/organizations.js',
  'sections/services.js',
  'sections/causes.js',
  'sections/section-adapters.js',
  'core/job-state.js',
  'core/capture-data.js',
  'exporter.js'
);

const VERSION = chrome.runtime.getManifest().version;
const R = globalThis.LinkedInRuntime;
const state = globalThis.LinkedInJobState;
const utils = globalThis.LinkedInExportUtils;
const { slimProfileData, slimSection } = globalThis.LinkedInCaptureData;
const JOB_PREFIX = 'li_single_tab_export_job_';
const GUARD_PREFIX = 'li_export_guard_';
const CLEANUP_ALARM = 'li_export_cleanup';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jobKey = (tabId) => `${JOB_PREFIX}${tabId}`;
const guardName = (tabId) => `${GUARD_PREFIX}${tabId}`;

// Every event shares one mutation queue. Chrome storage has no compare-and-swap;
// uncoordinated read/modify/write handlers used to resurrect cancelled jobs.
let pending = Promise.resolve();
function enqueue(operation) {
  const next = pending.then(operation);
  pending = next.catch(() => {});
  return next;
}

async function getJob(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }
  const result = await chrome.storage.session.get(jobKey(tabId));
  return result[jobKey(tabId)] || null;
}

async function getJobById(id) {
  if (typeof id !== 'string' || !id) {
    return null;
  }
  return (await allJobs()).find((job) => job.id === id) || null;
}

async function allJobs() {
  const result = await chrome.storage.session.get(null);
  return Object.entries(result)
    .filter(([key]) => key.startsWith(JOB_PREFIX))
    .map(([, job]) => job)
    .filter(Boolean);
}

async function clearJob(tabId) {
  await chrome.storage.session.remove(jobKey(tabId));
  await chrome.alarms.clear(guardName(tabId));
}

async function setJob(job) {
  state.normalize(job);
  job.exporterVersion = VERSION;
  job.updatedAt = Date.now();
  if (state.isTerminal(job)) {
    // Keep a short-lived status for the HUD, never the captured profile records.
    job.results = null;
    job.queue = [];
    job.captureToken = '';
    job.guard = null;
    job.dispatched = false;
    job.terminalAt ||= Date.now();
  }
  if (JSON.stringify(job).length * 2 > R.LIMITS.jobBytes) {
    throw new Error('This export exceeds the temporary storage limit.');
  }
  await chrome.storage.session.set({ [jobKey(job.tabId)]: job });
}

function transition(job, phase, reason) {
  if (!state.transition(job, phase, { reason })) {
    throw new Error('Invalid export state transition.');
  }
}

function publicJob(job) {
  if (!job) {
    return null;
  }
  return {
    id: job.id,
    tabId: job.tabId,
    profileUrl: job.profileUrl,
    phase: job.phase,
    profileName: job.profileName || '',
    currentTitle: job.currentTitle || '',
    tasks: job.tasks || [],
    filename: job.filename || '',
    error: job.error || '',
    warnings: job.warnings || []
  };
}

function markTask(job, key, patch) {
  const task = job.tasks.find((value) => value.key === key);
  if (task) {
    Object.assign(task, patch);
  } else {
    job.tasks.push({ key, title: key, status: 'pending', detail: '', ...patch });
  }
}

async function sendToPage(tabId, message, options = { frameId: 0 }) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, options),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The page did not acknowledge the extension message.')),
          3000
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function notifyHud(job) {
  try {
    await sendToPage(job.tabId, { type: 'HUD_JOB_STATE', job: publicJob(job) }, { frameId: 0 });
  } catch {
    /* The content script is absent while the tab navigates. */
  }
}

async function failJob(job, error, taskKey = 'package') {
  if (!job || state.isTerminal(job)) {
    return;
  }
  transition(job, 'error', 'runtime-error');
  job.error = String(error || 'Export failed.').slice(0, 400);
  markTask(job, taskKey, { status: 'error', detail: job.error });
  await chrome.alarms.clear(guardName(job.tabId));
  await setJob(job);
  await notifyHud(job);
}

function backgroundTask(operation, tabId) {
  enqueue(operation).catch(async () => {
    // Fail visibly without logging captured profile data.
    if (Number.isInteger(tabId)) {
      await enqueue(async () =>
        failJob(
          await getJob(tabId),
          'The export could not continue. Refresh the profile and try again.'
        )
      ).catch(() => {});
    }
    console.error('LinkedIn export background operation failed.');
  });
}

async function setGuard(job, type, ms) {
  job.guard = {
    type,
    expiresAt: Date.now() + ms,
    phase: job.phase,
    captureToken: job.captureToken
  };
  await setJob(job);
  await chrome.alarms.create(guardName(job.tabId), { when: job.guard.expiresAt });
}

async function navigateJob(job, url, title, phase) {
  transition(job, phase, 'navigate');
  job.currentUrl = url;
  job.currentTitle = title;
  job.dispatched = false;
  job.captureToken = '';
  job.captureDocumentId = '';
  await setGuard(job, 'navigation', 60000);
  await notifyHud(job);
  await chrome.tabs.update(job.tabId, { url });
}

async function sendWithRetry(tabId, message, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await sendToPage(tabId, message);
    } catch {
      if (i === attempts - 1) {
        throw new Error(
          'Refresh this LinkedIn profile after installing or updating the extension, then try again.'
        );
      }
      await sleep(250 + i * 150);
    }
  }
}

async function dispatchCurrent(tabId, { allowLoading = false } = {}) {
  const job = await getJob(tabId);
  if (!job || !['profile', 'detail', 'returning'].includes(job.phase) || job.dispatched) {
    return;
  }
  const tab = await chrome.tabs.get(tabId);
  if ((!allowLoading && tab.status !== 'complete') || !R.samePageUrl(tab.url, job.currentUrl)) {
    return;
  }
  if (job.phase === 'returning') {
    transition(job, 'complete', 'download-complete-and-returned');
    job.currentTitle = 'Export complete';
    await chrome.alarms.clear(guardName(tabId));
    await setJob(job);
    await notifyHud(job);
    return;
  }

  job.dispatched = true;
  job.captureToken = crypto.randomUUID();
  const link = job.queue[job.currentIndex];
  if (job.phase === 'detail' && !link) {
    return prepareDownload(job);
  }
  const key = job.phase === 'profile' ? 'main-profile' : `detail:${link.key}`;
  markTask(job, key, { status: 'active', detail: 'Capturing in one forward pass…' });
  await setGuard(job, 'capture', job.phase === 'profile' ? 75000 : 180000);
  await notifyHud(job);
  try {
    const response = await sendWithRetry(tabId, {
      type: 'RUN_VISIBLE_CAPTURE',
      kind: job.phase,
      jobId: job.id,
      captureToken: job.captureToken,
      includeContact: job.includeContact,
      expectedTitle: link?.title || '',
      expectedKey: link?.key || '',
      expectedSlug: link?.slug || '',
      expectedCount: link?.expectedCount || 0,
      job: publicJob(job)
    });
    if (!response?.ok || response.started !== true) {
      throw new Error(response?.error || 'The page could not start this capture.');
    }
  } catch (error) {
    await finishCapture(job, { kind: job.phase, ok: false, error: error.message });
  }
}

async function startJob(message) {
  if (!Number.isInteger(message.tabId)) {
    throw new Error('Invalid profile tab.');
  }
  const tab = await chrome.tabs.get(message.tabId);
  const profileUrl = R.canonicalProfileUrl(tab.url);
  if (!profileUrl) {
    throw new Error('Open a LinkedIn profile (linkedin.com/in/...) first.');
  }
  await cleanupJobs();
  if ((await allJobs()).some((job) => !state.isTerminal(job))) {
    throw new Error('An export is already running. Finish or cancel it before starting another.');
  }
  if (R.samePageUrl(tab.url, profileUrl)) {
    const response = await sendWithRetry(tab.id, { type: 'GET_CAPTURE_PREFLIGHT' });
    const preflight = response?.preflight;
    if (!response?.ok || !preflight?.ok || !preflight.hasProfileName) {
      throw new Error('The profile is not ready. Wait for it to load or refresh the page.');
    }
    if (!preflight.nearTop) {
      throw new Error('Scroll to the top of the LinkedIn profile, then start the export again.');
    }
  }
  const job = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    profileUrl,
    currentUrl: profileUrl,
    currentTitle: 'Main profile',
    phase: 'profile',
    includeContact: message.includeContact === true,
    scanDetailPages: message.scanDetailPages !== false,
    queue: [],
    currentIndex: 0,
    results: { main: null, mainCheckpoint: null, detailCheckpoint: null, details: [] },
    tasks: [
      { key: 'main-profile', title: 'Main profile', status: 'active', detail: 'Preparing…' },
      {
        key: 'package',
        title: 'Create Markdown + images ZIP',
        status: 'pending',
        detail: 'Pending'
      }
    ],
    warnings: [],
    events: [],
    completed_steps: [],
    startedAt: Date.now(),
    dispatched: false,
    captureToken: ''
  };
  if (R.samePageUrl(tab.url, profileUrl)) {
    await setGuard(job, 'navigation', 60000);
    await dispatchCurrent(tab.id);
  } else {
    await navigateJob(job, profileUrl, 'Main profile', 'profile');
  }
  return { ok: true, job: publicJob(job) };
}

function captureMatches(job, message, sender) {
  return (
    job &&
    ['profile', 'detail'].includes(job.phase) &&
    job.dispatched &&
    message.jobId === job.id &&
    message.kind === job.phase &&
    typeof message.captureToken === 'string' &&
    message.captureToken.length > 0 &&
    message.captureToken === job.captureToken &&
    R.canonicalProfileUrl(sender.currentUrl) === job.profileUrl &&
    (!job.captureDocumentId || sender.documentId === job.captureDocumentId)
  );
}

function contactPolicy(data, job) {
  if (!job.includeContact) {
    data.contact_info = { available: false, items: [], websites: [] };
  }
  return data;
}

async function handleCapture(message, sender, checkpoint) {
  const job = await getJob(sender.tab.id);
  if (!captureMatches(job, message, sender) || !isExpectedPage(job, sender.currentUrl)) {
    return {
      ok: false,
      stale: true,
      error: 'Capture session no longer matches this page. Refresh the profile and start again.'
    };
  }
  const data = message.kind === 'profile' ? message.data : message.section;
  try {
    if (checkpoint || message.ok) {
      R.assertCaptureData(data, message.kind, job);
    }
  } catch (error) {
    await failJob(
      job,
      error.message,
      message.kind === 'profile' ? 'main-profile' : `detail:${job.queue[job.currentIndex]?.key}`
    );
    return { ok: false, error: error.message };
  }
  job.captureDocumentId ||= sender.documentId || '';
  if (checkpoint) {
    if (message.kind === 'profile') {
      job.results.mainCheckpoint = slimProfileData(contactPolicy(data, job));
      job.profileName = data.top.name;
    } else {
      job.results.detailCheckpoint = slimSection(data);
    }
    await setJob(job);
  } else {
    await finishCapture(job, message);
  }
  return { ok: true };
}

function sectionCount(section) {
  return utils.countSectionRecords(section);
}

async function finishCapture(job, message) {
  await chrome.alarms.clear(guardName(job.tabId));
  job.guard = null;
  job.dispatched = false;
  job.captureToken = '';
  if (message.kind === 'profile') {
    if (message.fatal) {
      return failJob(job, message.error || 'Profile capture could not continue.', 'main-profile');
    }
    const data = message.ok ? message.data : job.results.mainCheckpoint;
    if (!data) {
      return failJob(job, message.error || 'The profile could not be captured.', 'main-profile');
    }
    job.profileName = data.top.name;
    job.results.main = slimProfileData(contactPolicy(data, job));
    job.results.mainCheckpoint = null;
    job.queue = job.scanDetailPages ? R.detailLinks(data.detail_links, job.profileUrl) : [];
    job.currentIndex = 0;
    const partial = !message.ok || data.meta?.budget_expired;
    markTask(job, 'main-profile', {
      status: partial ? 'warn' : 'done',
      detail: partial ? 'Partial profile captured; the time limit was reached.' : 'Captured'
    });
    for (const section of data.sections) {
      if (!job.queue.some((link) => link.key === section.key)) {
        const count = sectionCount(section);
        const expected = Number(section.count || 0);
        markTask(job, `main:${section.key}`, {
          title: section.title,
          status: expected > count ? 'warn' : 'done',
          detail: expected ? `${count}/${expected} captured` : `${count} captured`
        });
      }
    }
    for (const link of job.queue) {
      markTask(job, `detail:${link.key}`, {
        title: link.title,
        status: 'pending',
        detail: 'Pending'
      });
    }
  } else {
    const link = job.queue[job.currentIndex];
    if (!link) {
      return failJob(job, 'The detail queue is inconsistent.');
    }
    let section = message.ok ? message.section : job.results.detailCheckpoint;
    if (!section) {
      section = {
        key: link.key,
        title: link.title,
        source_url: link.url,
        items: [],
        available: false
      };
    }
    const explicitlyAbsent = Boolean(message.ok && section.skipped && section.available === false);
    if (explicitlyAbsent) {
      // Optional LinkedIn profile sections are not required. A verified empty/null
      // section is normal profile state: do not persist it and do not warn/fail.
      job.results.detailCheckpoint = null;
      markTask(job, `detail:${link.key}`, {
        status: 'done',
        detail: 'No data on profile · skipped'
      });
      job.currentIndex += 1;
      const next = job.queue[job.currentIndex];
      if (next) {
        await navigateJob(job, next.url, next.title, 'detail');
      } else {
        await prepareDownload(job);
      }
      return;
    }

    // Recover only inside a verified section, preserving adjacent field values.
    // Broad page text (navigation, ads, footer) is never promoted into records.
    const expected = link.expectedCount || Number(section.count || 0);
    if (
      (section.extraction?.exact_root || section.extraction?.verified_scope) &&
      (expected > sectionCount(section) || sectionCount(section) === 0) &&
      section.rendered_text_snapshot
    ) {
      section = utils.applyFallbackText(
        [section],
        [
          {
            key: link.key,
            title: link.title,
            url: link.url,
            text: section.rendered_text_snapshot,
            source_kind: 'single-pass-rendered-text',
            expected_count: expected
          }
        ]
      )[0];
    }
    job.results.details.push(slimSection(section));
    job.results.detailCheckpoint = null;
    const count = sectionCount(section);
    const partial = !message.ok || section.extraction?.budget_expired || expected > count || !count;
    markTask(job, `detail:${link.key}`, {
      status: partial ? 'warn' : 'done',
      detail: expected
        ? `${count}/${expected} captured${partial ? ' · possibly incomplete' : ''}`
        : `${count} captured${partial ? ' · review this section' : ''}`
    });
    job.currentIndex += 1;
  }
  const next = job.queue[job.currentIndex];
  if (next) {
    await navigateJob(job, next.url, next.title, 'detail');
  } else {
    await prepareDownload(job);
  }
}

function finalDataFromJob(job) {
  if (!job.results?.main) {
    return null;
  }
  const data = structuredClone(job.results.main);
  data.sections = utils.mergeSections(data.sections || [], job.results.details || []);
  data.meta = { ...(data.meta || {}), exporter_version: VERSION };
  return contactPolicy(data, job);
}

async function prepareDownload(job) {
  if (!job.results?.main) {
    return failJob(job, 'No usable profile data was captured.');
  }
  transition(job, 'packaging', 'capture-complete');
  job.results.mainCheckpoint = null;
  job.results.detailCheckpoint = null;
  await setJob(job);
  job.filename = `${utils.sanitizeFilename(job.profileName)}-LinkedIn-Export.zip`;
  job.currentTitle = 'Export ready';
  transition(job, 'download', 'package-ready');
  job.downloadUrl =
    chrome.runtime.getURL('download.html') + '?' + new URLSearchParams({ jobId: job.id });
  job.currentUrl = job.profileUrl;
  markTask(job, 'package', {
    status: 'active',
    detail: 'Export ready · choose Download ZIP when ready'
  });
  await setGuard(job, 'download', 900000);

  // Keep LinkedIn available in the original tab. The export result is a separate
  // app-like window so the user can review the captured profile before downloading.
  try {
    const sourceTab = await chrome.tabs.get(job.tabId);
    if (!R.samePageUrl(sourceTab.url, job.profileUrl)) {
      await chrome.tabs.update(job.tabId, { url: job.profileUrl });
    }
  } catch {
    job.sourceTabClosed = true;
  }

  let exportWindow;
  try {
    exportWindow = await chrome.windows.create({
      url: job.downloadUrl,
      type: 'popup',
      focused: true,
      width: 1440,
      height: 940
    });
  } catch (error) {
    return failJob(job, error.message || 'The export window could not be opened.');
  }

  job.downloadWindowId = exportWindow?.id;
  job.downloadTabId = exportWindow?.tabs?.[0]?.id;
  if (!Number.isInteger(job.downloadTabId) && Number.isInteger(job.downloadWindowId)) {
    const tabs = await chrome.tabs.query({ windowId: job.downloadWindowId });
    job.downloadTabId = tabs.find((tab) => isDownloadUrl(tab.url, job.id))?.id;
  }
  await setGuard(job, 'download', 900000);
  await notifyHud(job);
}

async function finishDownload(job, item) {
  if (job.phase !== 'download' || !item) {
    return;
  }
  if (item.state === 'interrupted') {
    // A cancelled/interrupted browser save must not force the user to recapture
    // the profile. Keep the prepared export alive in the dedicated export window.
    job.downloadId = undefined;
    job.currentTitle = 'Export ready to save';
    markTask(job, 'package', {
      status: 'active',
      detail:
        item.error === 'USER_CANCELED'
          ? 'Save cancelled · ZIP is still ready to retry'
          : `Download interrupted · ready to retry (${item.error || 'unknown reason'})`
    });
    await setGuard(job, 'download', 900000);
    return;
  }
  if (item.state !== 'complete') {
    return;
  }
  markTask(job, 'package', {
    status: job.warnings.length ? 'warn' : 'done',
    detail: job.warnings.length
      ? `ZIP saved · ${job.warnings.join('; ')}`
      : 'ZIP saved successfully'
  });
  job.results = null;
  job.currentTitle = 'Export saved';
  transition(job, 'complete', 'download-saved');
  await chrome.alarms.clear(guardName(job.tabId));
  await setJob(job);
  await notifyHud(job);
}

async function cancelJob(job) {
  if (!job || state.isTerminal(job)) {
    return { ok: false };
  }
  if (Number.isInteger(job.downloadId)) {
    await chrome.downloads.cancel(job.downloadId).catch(() => {});
  }
  transition(job, 'cancelled', 'user-cancelled');
  job.currentTitle = 'Export cancelled';
  await chrome.alarms.clear(guardName(job.tabId));
  await setJob(job);
  await notifyHud(job);
  const tab = await chrome.tabs.get(job.tabId);
  if (!R.samePageUrl(tab.url, job.profileUrl)) {
    await chrome.tabs.update(job.tabId, { url: job.profileUrl });
  }
  return { ok: true };
}

async function handleGuardTimeout(tabId) {
  const job = await getJob(tabId);
  if (!job?.guard || state.isTerminal(job)) {
    return;
  }
  // An already queued alarm may belong to an older phase. Never expire a new guard early.
  if (Date.now() < job.guard.expiresAt) {
    await chrome.alarms.create(guardName(tabId), { when: job.guard.expiresAt });
    return;
  }
  if (job.phase === 'returning') {
    transition(job, 'complete', 'download-saved-return-timeout');
    await setJob(job);
    return;
  }
  if (job.phase === 'download') {
    if (Number.isInteger(job.downloadId)) {
      const [item] = await chrome.downloads.search({ id: job.downloadId });
      if (item?.state === 'complete' || item?.state === 'interrupted') {
        return finishDownload(job, item);
      }
    }
    return failJob(job, 'The export page stopped responding. Start a new export from the profile.');
  }

  // A LinkedIn navigation can visually finish without Chrome delivering the
  // exact status=complete event we were waiting for (SPA transitions and reused
  // documents are the common cases). If the tab is already on the expected URL,
  // force one dispatch attempt; the content script has its own bounded DOM-ready
  // checks and will either capture or return a checkpoint-backed warning.
  if (job.guard.type === 'navigation' && !job.dispatched) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (R.samePageUrl(tab.url, job.currentUrl)) {
        job.guard = null;
        await setJob(job);
        await dispatchCurrent(tabId, { allowLoading: true });
        const refreshed = await getJob(tabId);
        if (refreshed?.dispatched) {
          return;
        }
      }
    } catch {
      /* Fall through to the bounded checkpoint recovery below. */
    }
  }

  await finishCapture(job, {
    kind: job.phase,
    ok: false,
    error: 'Capture timed out. The last saved checkpoint was used where available.'
  });
}

async function cleanupJobs() {
  const now = Date.now();
  for (const job of await allJobs()) {
    const age = now - (state.isTerminal(job) ? job.terminalAt || job.updatedAt : job.startedAt);
    if (
      job.exporterVersion !== VERSION ||
      age > (state.isTerminal(job) ? R.LIMITS.terminalMs : R.LIMITS.activeMs)
    ) {
      if (!state.isTerminal(job)) {
        await notifyHud({
          ...job,
          phase: 'error',
          error: 'This export expired. Start a new export.'
        });
      }
      await clearJob(job.tabId);
    }
  }
}

async function resumeSessionJobs() {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 5 });
  await cleanupJobs();
  for (const job of await allJobs()) {
    if (state.isTerminal(job)) {
      continue;
    }

    if (job.phase === 'download') {
      if (Number.isInteger(job.downloadId)) {
        const [item] = await chrome.downloads.search({ id: job.downloadId });
        if (item && item.state !== 'in_progress') {
          await finishDownload(job, item);
          continue;
        }
      }

      let exportTab = null;
      if (Number.isInteger(job.downloadTabId)) {
        try {
          exportTab = await chrome.tabs.get(job.downloadTabId);
        } catch {
          exportTab = null;
        }
      }
      if (!exportTab || !isDownloadUrl(exportTab.url, job.id)) {
        // If the worker restarted while the export was waiting, restore the app
        // window rather than losing the already captured profile data.
        const exportWindow = await chrome.windows.create({
          url: job.downloadUrl ||
            (chrome.runtime.getURL('download.html') + '?' + new URLSearchParams({ jobId: job.id })),
          type: 'popup',
          focused: false,
          width: 1440,
          height: 940
        });
        job.downloadWindowId = exportWindow?.id;
        job.downloadTabId = exportWindow?.tabs?.[0]?.id;
        if (!Number.isInteger(job.downloadTabId) && Number.isInteger(job.downloadWindowId)) {
          const tabs = await chrome.tabs.query({ windowId: job.downloadWindowId });
          job.downloadTabId = tabs.find((tab) => isDownloadUrl(tab.url, job.id))?.id;
        }
      }
      await setGuard(job, 'download', 900000);
      continue;
    }

    let tab;
    try {
      tab = await chrome.tabs.get(job.tabId);
    } catch {
      await clearJob(job.tabId);
      continue;
    }
    if (!isExpectedPage(job, tab.url)) {
      await failJob(job, 'The tab left the export page. Start a new export when ready.');
      continue;
    }
    // Preserve the original token: a content script can still be capturing while
    // the background worker sleeps. Re-dispatching would discard its response.
    if (job.phase === 'packaging') {
      await prepareDownload(job);
      continue;
    }
    if (!job.guard) {
      await setGuard(job, 'navigation', 90000);
    } else {
      await chrome.alarms.create(guardName(job.tabId), {
        when: Math.max(Date.now() + 100, job.guard.expiresAt)
      });
    }
    if (!job.dispatched) {
      await dispatchCurrent(job.tabId);
    }
  }
}

function isExpectedPage(job, url) {
  if (job.phase === 'download') {
    return R.samePageUrl(url, job.profileUrl) || isDownloadUrl(url, job.id);
  }
  if (R.samePageUrl(url, job.currentUrl)) {
    return true;
  }
  return job.phase === 'profile' && R.samePageUrl(url, `${job.profileUrl}overlay/contact-info/`);
}

function isExtensionPage(sender, name) {
  try {
    return (
      R.samePageUrl(sender.url, chrome.runtime.getURL(name)) && sender.id === chrome.runtime.id
    );
  } catch {
    return false;
  }
}

function isDownloadUrl(value, id) {
  try {
    return (
      R.samePageUrl(value, chrome.runtime.getURL('download.html')) &&
      new URL(value).searchParams.get('jobId') === id
    );
  } catch {
    return false;
  }
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string' || sender.id !== chrome.runtime.id) {
    return { ok: false, error: 'Untrusted extension message.' };
  }
  const popup = isExtensionPage(sender, 'popup.html') && !sender.tab;
  // LinkedIn reuses documents during client-side navigation. Validate the
  // sender origin, then read the current tab URL from Chrome, not a potentially
  // older document URL. Tokens and document binding remain mandatory below.
  const senderUrl = R.parseHttps(sender.url);
  const content =
    sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) &&
    senderUrl?.hostname === 'www.linkedin.com';
  if (content) {
    const tab = await chrome.tabs.get(sender.tab.id);
    sender = { ...sender, currentUrl: tab.url };
    if (
      !R.canonicalProfileUrl(tab.url) ||
      (message.pageUrl && !R.samePageUrl(message.pageUrl, tab.url))
    ) {
      return { ok: false, error: 'The active page changed during capture.' };
    }
  }
  const download =
    sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) &&
    isExtensionPage(sender, 'download.html');
  if (message.type === 'START_SINGLE_TAB_EXPORT') {
    if (!popup) {
      return { ok: false, error: 'Start exports from the extension popup.' };
    }
    return startJob(message);
  }
  if (['CAPTURE_CHECKPOINT', 'PAGE_CAPTURE_COMPLETE'].includes(message.type)) {
    if (!content) {
      return { ok: false };
    }
    return handleCapture(message, sender, message.type === 'CAPTURE_CHECKPOINT');
  }
  if (!content && !download) {
    return { ok: false, error: 'Untrusted message sender.' };
  }
  const requestedJobId =
    download
      ? (message.jobId || new URL(sender.url).searchParams.get('jobId') || '')
      : '';
  const job = download ? await getJobById(requestedJobId) : await getJob(sender.tab.id);
  if (
    !job ||
    (content && R.canonicalProfileUrl(sender.currentUrl) !== job.profileUrl) ||
    (download &&
      (!isDownloadUrl(sender.url, job.id) ||
        (Number.isInteger(job.downloadTabId) && sender.tab.id !== job.downloadTabId)))
  ) {
    return { ok: false, error: 'Export job is unavailable.' };
  }
  if (message.type === 'GET_SINGLE_TAB_JOB') {
    return { ok: true, job: publicJob(job) };
  }
  if (message.type === 'CANCEL_SINGLE_TAB_EXPORT') {
    if (download && state.isTerminal(job)) {
      if (Number.isInteger(job.tabId)) {
        await chrome.tabs.update(job.tabId, { active: true }).catch(() => {});
      }
      return { ok: true };
    }
    return cancelJob(job);
  }
  if (message.type === 'SCRAPE_PROGRESS') {
    return { ok: true };
  }
  if (!download || job.phase !== 'download' || message.jobId !== job.id) {
    return { ok: false, error: 'Export job is not ready.' };
  }
  if (message.type === 'GET_FINAL_EXPORT_DATA') {
    const data = finalDataFromJob(job);
    return data
      ? { ok: true, data, filename: job.filename }
      : { ok: false, error: 'Captured data is unavailable.' };
  }
  if (message.type === 'DOWNLOAD_HEARTBEAT') {
    await setGuard(job, 'download', 900000);
    return { ok: true };
  }
  if (message.type === 'EXPORT_DOWNLOAD_STARTED') {
    if (!Number.isInteger(message.downloadId)) {
      return { ok: false };
    }
    if (job.downloadId !== undefined && job.downloadId !== message.downloadId) {
      const [previous] = await chrome.downloads.search({ id: job.downloadId });
      if (previous?.state !== 'interrupted') {
        return { ok: false };
      }
      job.downloadId = undefined;
    }
    const [item] = await chrome.downloads.search({ id: message.downloadId });
    if (!item || !item.url?.startsWith(`blob:${chrome.runtime.getURL('')}`)) {
      return { ok: false, error: 'Invalid download.' };
    }
    job.downloadId = item.id;
    job.warnings = Array.isArray(message.warnings)
      ? message.warnings
          .filter((x) => typeof x === 'string')
          .map((x) => x.slice(0, 180))
          .slice(0, 2)
      : [];
    await setGuard(job, 'download', 900000);
    await finishDownload(job, item);
    return { ok: true };
  }
  if (message.type === 'EXPORT_DOWNLOAD_FAILED') {
    await failJob(job, String(message.error || 'Could not save ZIP.'));
    return { ok: true };
  }
  return { ok: false, error: 'Unsupported export message.' };
}

// Register listeners synchronously so events can wake a suspended MV3 worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  enqueue(() => handleMessage(message, sender))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Export failed.' }));
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && change.status !== 'complete') {
    return;
  }
  backgroundTask(async () => {
    const job = await getJob(tabId);
    if (!job || state.isTerminal(job)) {
      return;
    }
    if (job.phase === 'download') {
      // Capture is complete. The original LinkedIn tab is now independent of the
      // export window and the user may continue browsing it freely.
      return;
    }
    const currentTab = await chrome.tabs.get(tabId);
    const url = currentTab.url;
    if (url && !isExpectedPage(job, url)) {
      await failJob(job, 'The tab left the export page. Start a new export when ready.');
      return;
    }
    if (change.status === 'complete') {
      await dispatchCurrent(tabId);
    }
  }, tabId);
});
chrome.tabs.onRemoved.addListener((tabId) =>
  backgroundTask(async () => {
    const sourceJob = await getJob(tabId);
    if (sourceJob) {
      if (sourceJob.phase === 'download') {
        sourceJob.sourceTabClosed = true;
        await setJob(sourceJob);
      } else {
        await clearJob(tabId);
      }
      return;
    }
    const downloadJob = (await allJobs()).find((job) => job.downloadTabId === tabId);
    if (downloadJob && !state.isTerminal(downloadJob)) {
      // Closing the export window abandons only the prepared handoff. The capture
      // is no longer needed, so clear it and allow a fresh export immediately.
      await clearJob(downloadJob.tabId);
    }
  }, tabId)
);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEANUP_ALARM) {
    backgroundTask(cleanupJobs);
  } else if (alarm.name.startsWith(GUARD_PREFIX)) {
    const tabId = Number(alarm.name.slice(GUARD_PREFIX.length));
    if (Number.isInteger(tabId)) {
      backgroundTask(() => handleGuardTimeout(tabId), tabId);
    }
  }
});
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) {
    return;
  }
  backgroundTask(async () => {
    const job = (await allJobs()).find(
      (value) => value.phase === 'download' && value.downloadId === delta.id
    );
    if (!job) {
      return;
    }
    const [item] = await chrome.downloads.search({ id: delta.id });
    await finishDownload(job, item);
  });
});
chrome.runtime.onStartup.addListener(() => backgroundTask(resumeSessionJobs));
backgroundTask(resumeSessionJobs);
