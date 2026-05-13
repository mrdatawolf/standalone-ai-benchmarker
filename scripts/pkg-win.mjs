/**
 * Build the Windows exe with icon embedded in the base Node binary BEFORE
 * pkg appends its VFS. Applying rcedit after pkg (post-build) strips the
 * overlay data (the pkg VFS) causing "Pkg: Error reading from file."
 *
 * Correct order:
 *   1. Find/download the pkg base Node binary
 *   2. Copy it and embed the icon with rcedit
 *   3. Point pkg at the modified copy via PKG_NODE_PATH
 *   4. pkg appends the VFS to the already-icon-embedded binary
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { rcedit } from 'rcedit';

const PKG_CMD   = 'npx @yao-pkg/pkg dist/bundle.cjs --targets node22-win-x64 --output dist/ai-bench-win.exe --config pkg.config.json';
const ICON_PATH = 'Samples/wolf-race.ico';
const ICON_BASE = 'dist/node22-win-icon-base.exe';

function findCachedBinary() {
  const cacheRoot = process.env.PKG_CACHE_PATH || join(homedir(), '.pkg-cache');
  if (!existsSync(cacheRoot)) return null;
  for (const tag of readdirSync(cacheRoot).sort().reverse()) {
    const dir = join(cacheRoot, tag);
    const match = readdirSync(dir)
      .filter(f => /^fetched-v22\.\d+\.\d+-win-x64$/.test(f))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    if (match.length) return join(dir, match[0]);
  }
  return null;
}

let baseBin = findCachedBinary();
if (!baseBin) {
  // Let pkg download the base binary by running a build first
  console.log('Base binary not cached — running pkg to download it...');
  execSync(PKG_CMD, { stdio: 'inherit' });
  baseBin = findCachedBinary();
  if (!baseBin) throw new Error('Could not locate pkg base binary after download.');
}
console.log(`Using base binary: ${baseBin}`);

// Copy the base binary and embed the icon into the copy
copyFileSync(baseBin, ICON_BASE);
await rcedit(ICON_BASE, { icon: ICON_PATH });
console.log('Icon embedded in base binary copy');

// Build the final exe: pkg will append its VFS to the icon-embedded base binary
console.log('Building exe...');
execSync(PKG_CMD, {
  stdio: 'inherit',
  env: { ...process.env, PKG_NODE_PATH: ICON_BASE },
});
rmSync(ICON_BASE);
console.log('Done → dist/ai-bench-win.exe');
