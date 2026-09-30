'use strict';
const exportBtn = document.getElementById('exportBtn');
const statusEl = document.getElementById('status');
const includeContactEl = document.getElementById('includeContact');
const scanDetailPagesEl = document.getElementById('scanDetailPages');
const versionEl = document.getElementById('version');
if (versionEl) {
  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
}

function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

async function activeProfileTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !globalThis.LinkedInRuntime.canonicalProfileUrl(tab.url)) {
    throw new Error('Open a LinkedIn profile (linkedin.com/in/...) first.');
  }
  return tab;
}

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  try {
    const tab = await activeProfileTab();
    const response = await chrome.runtime.sendMessage({
      type: 'START_SINGLE_TAB_EXPORT',
      tabId: tab.id,
      includeContact: includeContactEl.checked,
      scanDetailPages: scanDetailPagesEl.checked
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not start export.');
    }
    setStatus(
      'Capture started. Keep LinkedIn open; the finished export will appear in a separate window.',
      'success'
    );
    setTimeout(() => window.close(), 700);
  } catch (error) {
    setStatus(error?.message || String(error), 'error');
    exportBtn.disabled = false;
  }
});
