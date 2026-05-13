import { build } from 'esbuild';
import { readFile, rmSync, mkdirSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';

const readFileAsync = promisify(readFile);

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

// Inline all files from src/web/public directly into bundle.cjs as string/base64
// constants. This avoids storing them as separate pkg VFS asset entries, whose
// binary reads fail on some Windows machines (AV scanning corrupts offsets).
const inlinePublicPlugin = {
  name: 'inline-public',
  setup(b) {
    b.onLoad({ filter: /[/\\]public[/\\][^/\\]+\.(html|js|css)$/ }, async ({ path }) => {
      const text = await readFileAsync(path, 'utf8');
      return { contents: `export default ${JSON.stringify(text)}`, loader: 'js' };
    });
    b.onLoad({ filter: /[/\\]public[/\\][^/\\]+\.(png|ico|gif|svg|woff2?)$/ }, async ({ path }) => {
      const buf = await readFileAsync(path);
      return { contents: `export default "${buf.toString('base64')}"`, loader: 'js' };
    });
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
  plugins:     [nodeSqlitePlugin, inlinePublicPlugin],
  // Polyfill import.meta.url for CJS output so __dirname resolves correctly
  banner: {
    js: `const __importMetaUrl = require('url').pathToFileURL(__filename).href;`,
  },
  define: {
    'import.meta.url': '__importMetaUrl',
  },
});

console.log('Done → dist/bundle.cjs');
