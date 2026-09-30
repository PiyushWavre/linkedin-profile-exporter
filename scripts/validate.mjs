import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const root = new URL('../', import.meta.url).pathname;
const required = [
  'manifest.json',
  'service-worker.js',
  'content.js',
  'exporter.js',
  'download.html',
  'download.js',
  'download.css',
  'popup.html',
  'popup.js',
  'popup.css',
  'README.md',
  'LICENSE',
  'PRIVACY.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md'
];

const errors = [];
for (const file of required) {
  if (!existsSync(join(root, file))) errors.push(`Missing required file: ${file}`);
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const popupHtml = readFileSync(join(root, 'popup.html'), 'utf8');
const popupJs = readFileSync(join(root, 'popup.js'), 'utf8');

if (manifest.manifest_version !== 3) errors.push('manifest.json must use Manifest V3.');
if (manifest.version !== pkg.version) errors.push(`Version mismatch: manifest=${manifest.version}, package=${pkg.version}`);
if (manifest.version !== '1.0.0') errors.push(`Public package must be version 1.0.0, found ${manifest.version}.`);
if (manifest.permissions?.includes('tabs')) errors.push('Unexpected broad tabs permission.');
if (manifest.host_permissions?.includes('<all_urls>')) errors.push('Unexpected <all_urls> host permission.');

const expectedHosts = new Set(['https://www.linkedin.com/*', 'https://*.licdn.com/*']);
for (const host of manifest.host_permissions || []) {
  if (!expectedHosts.has(host)) errors.push(`Unexpected host permission: ${host}`);
}

if (/v1\.\d+\.\d+/.test(popupHtml)) errors.push('popup.html contains a hard-coded version.');
if (!popupJs.includes('chrome.runtime.getManifest().version')) errors.push('popup.js must read the version from manifest.json.');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (['.git', 'node_modules', 'dist'].includes(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

for (const file of walk(root).filter((file) => file.endsWith('.js') || file.endsWith('.mjs'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    errors.push(`JavaScript syntax check failed: ${relative(root, file)}\n${error.stderr?.toString() || ''}`);
  }
}

const forbiddenPublicFiles = [
  'AUDIT-REPORT.md',
  'AUTHORS.md',
  'GITHUB-PUBLISHING-GUIDE.md',
  'NOTICE.md',
  'ROADMAP.md',
  'SUPPORT.md',
  'CITATION.cff'
];
for (const file of forbiddenPublicFiles) {
  if (existsSync(join(root, file))) errors.push(`Public repository still contains internal/secondary root file: ${file}`);
}

if (errors.length) {
  console.error(errors.join('\n\n'));
  process.exit(1);
}

console.log(`LinkedIn Profile Exporter ${manifest.version}: repository validation passed.`);
