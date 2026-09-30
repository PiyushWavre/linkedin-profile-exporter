import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = new URL('../', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const out = join(dist, `linkedin-profile-exporter-v${manifest.version}.zip`);
rmSync(out, { force: true });

const files = [
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
  'zip.js',
  'PRIVACY.md',
  'SECURITY.md',
  'core',
  'sections',
  'icons'
];

try {
  execFileSync('zip', ['-X', '-q', '-r', out, ...files], { cwd: root, stdio: 'inherit' });
} catch {
  console.error('Could not create release ZIP. Install the standard `zip` command and run npm run package:release again.');
  process.exit(1);
}

console.log(out);
