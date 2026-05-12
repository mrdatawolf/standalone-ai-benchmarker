import express from 'express';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import open from 'open';
import { getRuns, getRunById, saveRun, markSynced } from '../storage/operations.js';
import { fetchAllRuns, pushRun } from '../sheets/client.js';
import { runBenchmark } from '../benchmark/engine.js';
import { getHardwareInfo } from '../benchmark/hardware.js';
import { config, getUserConfig, saveUserConfig } from '../config.js';
import { getAuthClient, hasValidToken } from '../sheets/auth.js';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startViewer(port = 3751) {
  const app = express();
  app.use(express.json());

  // Redirect to setup wizard if first run (before static files intercept /)
  app.get('/', (req, res) => {
    if (!getUserConfig().setupComplete) {
      return res.redirect('/setup.html');
    }
    res.sendFile(join(__dirname, 'public', 'index.html'));
  });

  // Serve static files (but don't auto-index so our / route above is used)
  app.use(express.static(join(__dirname, 'public'), { index: false }));

  // ── Setup API ─────────────────────────────────────────────────────────────

  app.get('/api/setup/status', (_req, res) => {
    const uc = getUserConfig();
    res.json({
      setupComplete:   !!uc.setupComplete,
      deviceName:      uc.deviceName ?? null,
      defaultProvider: uc.defaultProvider ?? config.defaultProvider ?? 'ollama',
      defaultBaseUrl:  uc.defaultBaseUrl  ?? config.defaultBaseUrl  ?? null,
      defaultModel:    uc.defaultModel    ?? config.defaultModel    ?? null,
      hasSheets:       !!(uc.sheetsId ?? config.sheetsId),
      hostname:        hostname(),
    });
  });

  app.get('/api/setup/check-provider', async (req, res) => {
    const url      = (req.query.url ?? 'http://localhost:11434').replace(/\/$/, '');
    const provider = req.query.provider ?? 'ollama';
    try {
      if (provider === 'ollama') {
        const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return res.json({ ok: false, reason: `Server returned HTTP ${r.status}` });
        const data   = await r.json();
        const models = (data.models ?? []).map(m => m.name).sort();
        return res.json({ ok: true, models });
      }
      // llamacpp / custom — try /v1/models then fall back to /v1/chat/completions ping
      const r = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const data   = await r.json();
        const models = (data.data ?? []).map(m => m.id);
        return res.json({ ok: true, models });
      }
      return res.json({ ok: false, reason: `Server returned HTTP ${r.status}` });
    } catch (err) {
      const reason = err.message.includes('timeout') || err.message.includes('ETIMEDOUT')
        ? 'Connection timed out — is the server running?'
        : 'Could not connect — is the server running?';
      return res.json({ ok: false, reason });
    }
  });

  app.post('/api/setup/save', (req, res) => {
    try {
      const allowed = [
        'deviceName', 'defaultProvider', 'defaultBaseUrl', 'defaultModel',
        'googleClientId', 'googleClientSecret', 'sheetsId', 'setupComplete',
      ];
      const updates = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }
      // Auto-generate deviceId on first save if not already set
      if (!getUserConfig().deviceId) updates.deviceId = randomUUID();
      saveUserConfig(updates);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Settings API ─────────────────────────────────────────────────────────

  app.get('/api/settings', (_req, res) => {
    const uc = getUserConfig();
    res.json({
      deviceName:     uc.deviceName ?? null,
      sheetsId:       uc.sheetsId   ?? config.sheetsId ?? null,
      hasCredentials: !!(uc.googleClientId     ?? process.env.GOOGLE_CLIENT_ID) &&
                      !!(uc.googleClientSecret ?? process.env.GOOGLE_CLIENT_SECRET),
      hasToken:       hasValidToken(),
    });
  });

  app.post('/api/settings/save', (req, res) => {
    try {
      const allowed = [
        'deviceName', 'defaultProvider', 'defaultBaseUrl', 'defaultModel',
        'googleClientId', 'googleClientSecret', 'sheetsId',
      ];
      const updates = {};
      for (const key of allowed) {
        const val = req.body[key];
        if (val !== undefined && val !== null && val !== '') updates[key] = val;
      }
      if (updates.sheetsId) {
        const m = updates.sheetsId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        if (m) updates.sheetsId = m[1];
        config.sheetsId = updates.sheetsId;
      }
      saveUserConfig(updates);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/settings/authorize', async (_req, res) => {
    try {
      await getAuthClient();
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // ── Benchmark / Data API ──────────────────────────────────────────────────

  app.post('/api/push/:runId', async (req, res) => {
    if (!config.sheetsId) return res.json({ ok: false, error: 'Google Sheet not configured — add one in Settings' });
    const run = getRunById(req.params.runId);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    try {
      await pushRun(run);
      markSynced(run.run_id);
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.get('/api/local', (_req, res) => {
    try { res.json(getRuns(50)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/sheet', async (_req, res) => {
    if (!config.sheetsId) return res.json({ error: 'Google Sheet not configured', rows: [] });
    try { res.json({ rows: await fetchAllRuns() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // SSE: run benchmark and stream progress
  app.get('/api/run', async (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const uc   = getUserConfig();
    const deviceId   = uc.deviceId   ?? randomUUID();
    const deviceName = uc.deviceName ?? null;

    let hardware;
    try {
      hardware = await getHardwareInfo();
    } catch (err) {
      send('error', { message: 'Hardware detection failed: ' + err.message });
      return res.end();
    }

    send('hardware', hardware);

    try {
      const result = await runBenchmark({
        onProgress:   ev => send('progress', ev),
        providerType: req.query.provider ?? config.defaultProvider ?? 'ollama',
        baseUrl:      req.query.baseUrl  ?? config.defaultBaseUrl  ?? undefined,
        model:        req.query.model    ?? config.defaultModel    ?? undefined,
      });

      const timestamp = new Date().toISOString();
      saveRun({ ...result, timestamp, deviceId, deviceName, hardware });

      if (config.sheetsId) {
        try {
          await pushRun({ ...result, timestamp, deviceId, deviceName, hardware });
          markSynced(result.runId);
        } catch { /* non-fatal */ }
      }

      send('done', { runId: result.runId });
    } catch (err) {
      send('error', { message: err.message });
    }

    res.end();
  });

  app.get('/api/config', (_req, res) => {
    const uc = getUserConfig();
    res.json({
      sheetsConfigured: !!config.sheetsId,
      defaultProvider:  config.defaultProvider ?? 'ollama',
      defaultModel:     config.defaultModel ?? null,
      defaultBaseUrl:   config.defaultBaseUrl ?? null,
      deviceName:       uc.deviceName ?? null,
    });
  });

  app.listen(port, '0.0.0.0', async () => {
    const url = `http://localhost:${port}`;
    console.log(`\nViewer running at ${url}`);
    console.log('  Local network: http://<your-ip>:' + port);
    console.log('Press Ctrl+C to stop.\n');
    try { await open(url); } catch { /* ignore */ }
  });

  await new Promise(() => {});
}
