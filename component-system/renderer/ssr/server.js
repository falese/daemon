import express        from 'express';
import { Writable }   from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath }    from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd    = process.env.NODE_ENV === 'production';
const PORT      = parseInt(process.env.PORT || '3003', 10);

// URL the *server* uses to fetch the initial snapshot from the daemon (HTTP).
const DAEMON_HTTP_URL = process.env.DAEMON_HTTP_URL || 'http://localhost:3001/graphql';

// Port the *browser* uses to reach the daemon WebSocket after hydration.
// This is the host-side port mapping (e.g. 3002 when node-daemon maps 3001→3002).
const PUBLIC_DAEMON_PORT = process.env.PUBLIC_DAEMON_PORT || '3001';

const clientDist = resolve(__dirname, 'dist/client');
const serverDist = resolve(__dirname, 'dist/server');

// ── Resolve production assets ─────────────────────────────────────────────────

let manifest = null;
let renderFn  = null;

if (isProd) {
  manifest = JSON.parse(readFileSync(resolve(clientDist, '.vite/manifest.json'), 'utf-8'));
  const { render } = await import(resolve(serverDist, 'entry-server.js'));
  renderFn = render;
}

function resolveAssetUrls() {
  if (!isProd) return { jsUrl: '/src/entry-client.jsx', cssUrl: '' };
  const entry = manifest['src/entry-client.jsx'];
  return {
    jsUrl:  `/assets/${entry.file}`,
    cssUrl: entry.css?.length ? `/assets/${entry.css[0]}` : '',
  };
}

// ── Initial state fetch ───────────────────────────────────────────────────────

async function fetchInitialState() {
  const gql = (query) =>
    fetch(DAEMON_HTTP_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query }),
      signal:  AbortSignal.timeout(3000),
    }).then(r => r.json());

  try {
    const [compResult, slotResult] = await Promise.all([
      gql('{ components { id type data createdAt slots } }'),
      gql('{ slotAssignments { parentComponentId slotName childComponentId } }'),
    ]);
    return {
      components:      compResult.data?.components      ?? [],
      slotAssignments: slotResult.data?.slotAssignments ?? [],
    };
  } catch (err) {
    console.error('[ssr] Failed to fetch initial state from daemon:', err.message);
    return { components: [], slotAssignments: [] };
  }
}

// ── HTML envelope ─────────────────────────────────────────────────────────────

function buildPreamble(initialState, cssUrl) {
  const stateJson = JSON.stringify(initialState);
  const portJson  = JSON.stringify(PUBLIC_DAEMON_PORT);
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '  <title>SSR Renderer — Control Plane</title>',
    cssUrl ? `  <link rel="stylesheet" href="${cssUrl}" />` : '',
    `  <script>window.__INITIAL_STATE__=${stateJson};window.__DAEMON_PORT__=${portJson};</script>`,
    '</head>',
    '<body>',
    '  <div id="root">',
  ].filter(Boolean).join('\n');
}

function buildPostamble(jsUrl) {
  return [
    '  </div>',
    `  <script type="module" src="${jsUrl}"></script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

// Production: serve built assets before the catch-all route
if (isProd) {
  app.use('/assets', express.static(resolve(clientDist, 'assets')));
}

// Dev: Vite middleware must be registered BEFORE the catch-all so that
// requests for /src/* and HMR assets are handled by Vite, not the SSR route.
if (!isProd) {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({ server: { middlewareMode: true }, appType: 'custom' });
  app.locals.vite = vite;
  app.use(vite.middlewares);
}

// Catch-all SSR route
app.get('*', async (req, res) => {
  try {
    const initialState = await fetchInitialState();
    const { jsUrl, cssUrl } = resolveAssetUrls();

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write(buildPreamble(initialState, cssUrl));

    // Intercept the end of React's stream to append the postamble before
    // closing the response.
    const body = new Writable({
      write(chunk, _enc, cb) { res.write(chunk); cb(); },
      final(cb) { res.write(buildPostamble(jsUrl)); res.end(); cb(); },
    });

    let abort;
    if (isProd) {
      abort = renderFn(initialState, body);
    } else {
      const { render } = await req.app.locals.vite.ssrLoadModule('/src/entry-server.jsx');
      abort = render(initialState, body);
    }
    req.on('close', () => abort?.());
  } catch (err) {
    console.error('[ssr] Request error:', err);
    if (!res.headersSent) res.status(500).send('<h1>Server Error</h1>');
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ssr] Renderer listening on port ${PORT} (${isProd ? 'production' : 'development'})`);
  console.log(`[ssr] Daemon HTTP : ${DAEMON_HTTP_URL}`);
  console.log(`[ssr] Public daemon port (browser): ${PUBLIC_DAEMON_PORT}`);
});
