/* eslint-disable no-console */
/**
 * The tiny server the Playwright suite runs against — the same static files `pnpm dev`
 * serves, and deliberately *nothing else*.
 *
 * No `/api/projects` route on purpose: `projectStore.js` probes for it and falls back to
 * `localStorage` when it isn't there (the same path the GitHub Pages build takes). That
 * gives every test its own empty, isolated store it can seed by hand, and means the suite
 * can never touch the real `playground-data/` projects on the machine running it.
 */
import { existsSync } from 'node:fs';
import express from 'express';

const PORT = Number(process.env.PLAYGROUND_TEST_PORT ?? 9010);

const BUNDLES = [
  'packages/mermaid/dist/mermaid.esm.mjs',
  'packages/mermaid-layout-elk/dist/mermaid-layout-elk.esm.mjs',
];

const missing = BUNDLES.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(
    `Missing built bundle(s):\n  ${missing.join('\n  ')}\n` +
      `The playground imports these directly — run \`pnpm build\` first.`
  );
  process.exit(1);
}

const app = express();
app.use(express.static('packages/mermaid/dist'));
app.use(express.static('packages/mermaid-layout-elk/dist'));
app.use(express.static('playground'));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`playground test server on http://127.0.0.1:${PORT}`);
});
