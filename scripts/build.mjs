import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';

// Clean dist
if (existsSync('dist')) rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

// pkg's static analyzer doesn't know node:sqlite (added in Node 22.5) and
// tries to open it as a file, crashing the build. This plugin wraps the import
// in a dynamic require (variable in require) so pkg skips it at analysis time
// but it still resolves correctly at runtime in the Node 22 exe.
const nodeSqlitePlugin = {
  name: 'node-sqlite-bypass',
  setup(build) {
    build.onResolve({ filter: /^node:sqlite$/ }, () => ({
      path: 'node:sqlite',
      namespace: 'node-sqlite-ns',
    }));
    build.onLoad({ filter: /.*/, namespace: 'node-sqlite-ns' }, () => ({
      contents: `var _m = 'node:sqlite'; module.exports = require(_m);`,
      loader: 'js',
    }));
  },
};

console.log('Bundling with esbuild...');
await build({
  entryPoints: ['src/cli.js'],
  bundle:      true,
  platform:    'node',
  target:      'node22',
  format:      'cjs',
  outfile:     'dist/bundle.cjs',
  plugins:     [nodeSqlitePlugin],
  // Polyfill import.meta.url for CJS output so __dirname resolves correctly
  banner: {
    js: `const __importMetaUrl = require('url').pathToFileURL(__filename).href;`,
  },
  define: {
    'import.meta.url': '__importMetaUrl',
  },
});

console.log('Copying static web files...');
cpSync('src/web/public', 'dist/public', { recursive: true });

console.log('Done → dist/bundle.cjs');
