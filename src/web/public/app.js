// ── Tab navigation ────────────────────────────────────────────────────────────
document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'history-tab')  loadHistory();
    if (btn.dataset.tab === 'compare-tab')  loadCompare();
    if (btn.dataset.tab === 'settings-tab') loadSettings();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = (n, d = 1) => (n == null || n === '') ? '—' : Number(n).toFixed(d);
const esc  = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const chip = (val, green, red) => {
  const cls = val === green ? 'green' : val === red ? 'red' : 'muted';
  return `<span class="chip ${cls}">${esc(val)}</span>`;
};

function renderRunTable(rows, cols) {
  if (!rows.length) return '<div class="empty">No runs found.</div>';
  const head = cols.map(c => `<th>${esc(c.label)}</th>`).join('');
  const body = rows.map(r =>
    `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : esc(r[c.key] ?? '—')}</td>`).join('')}</tr>`
  ).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ── Run Tab — model loading ───────────────────────────────────────────────────
const btnRun      = document.getElementById('btn-run');
const btnLoad     = document.getElementById('btn-load-models');
const selModel    = document.getElementById('sel-model');
const selProvider = document.getElementById('sel-provider');
const inpBaseUrl  = document.getElementById('inp-base-url');
const modelStatus = document.getElementById('model-status');
const stepsEl     = document.getElementById('steps-list');
const hwCards     = document.getElementById('hw-cards');
const lastRes     = document.getElementById('last-results');

const DEFAULT_URLS = {
  ollama:   'http://localhost:11434',
  llamacpp: 'http://localhost:8080',
  custom:   '',
};

function setModelStatus(type, msg) {
  modelStatus.className = type;
  modelStatus.textContent = msg;
  modelStatus.style.display = msg ? 'block' : 'none';
}

function clearModels(placeholder = '— click "Load Models" above —') {
  selModel.innerHTML = `<option value="">${placeholder}</option>`;
  selModel.disabled  = true;
  btnRun.disabled    = true;
  setModelStatus('', '');
}

// When provider changes, update the URL placeholder and clear the model list
selProvider.addEventListener('change', () => {
  const url = DEFAULT_URLS[selProvider.value] ?? '';
  inpBaseUrl.value = url;
  inpBaseUrl.placeholder = url || 'http://...';
  clearModels();
});

btnLoad.addEventListener('click', () => doLoadModels());

async function doLoadModels(preselectModel = null) {
  const provider = selProvider.value;
  const baseUrl  = inpBaseUrl.value.trim() || DEFAULT_URLS[provider] || '';

  btnLoad.disabled    = true;
  btnLoad.textContent = '…';
  clearModels('Loading…');

  try {
    const res  = await fetch(
      `/api/setup/check-provider?provider=${encodeURIComponent(provider)}&url=${encodeURIComponent(baseUrl)}`
    );
    const data = await res.json();

    selModel.innerHTML = '';
    selModel.disabled  = false;

    if (data.ok && data.models?.length) {
      data.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        selModel.appendChild(opt);
      });
      if (preselectModel && data.models.includes(preselectModel)) {
        selModel.value = preselectModel;
      }
      setModelStatus('ok', `✓ ${data.models.length} model${data.models.length === 1 ? '' : 's'} found`);
      btnRun.disabled = false;
    } else if (data.ok) {
      // Connected but no model list (e.g. llama.cpp running a single model)
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '— using server default —';
      selModel.appendChild(opt);
      setModelStatus('warn', 'Connected — this server doesn\'t list models. Using its loaded model.');
      btnRun.disabled = false;
    } else {
      clearModels('— not connected —');
      setModelStatus('err', '✗ ' + (data.reason || 'Could not connect to provider'));
    }
  } catch (err) {
    clearModels('— error —');
    setModelStatus('err', 'Error: ' + err.message);
  }

  btnLoad.disabled    = false;
  btnLoad.textContent = '↺ Load Models';
}

// ── On load: pre-populate from saved config ───────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    if (cfg.defaultProvider) selProvider.value = cfg.defaultProvider;
    if (cfg.defaultBaseUrl)  inpBaseUrl.value  = cfg.defaultBaseUrl;
    else if (cfg.defaultProvider) inpBaseUrl.value = DEFAULT_URLS[cfg.defaultProvider] ?? '';

    // Auto-load model list if a provider was configured during setup
    if (cfg.defaultProvider || cfg.defaultBaseUrl) {
      await doLoadModels(cfg.defaultModel ?? null);
    }
  } catch { /* ignore — user can click Load Models manually */ }
});

// ── Step progress cards ───────────────────────────────────────────────────────
const STEPS = [
  { id: 'connect', name: 'Connect', desc: 'Detecting hardware' },
  { id: 'probe',   name: 'Probe',   desc: 'Detecting reasoning capability' },
  { id: 'short',   name: 'Short',   desc: '~50 token prompt' },
  { id: 'medium',  name: 'Medium',  desc: '~300 token prompt' },
  { id: 'long',    name: 'Long',    desc: '~1,500 token prompt' },
  { id: 'stress',  name: 'Stress',  desc: '~3,500 token prefill diagnostic' },
];

function renderSteps() {
  stepsEl.innerHTML = STEPS.map(s =>
    `<div class="step-card pending" id="step-${s.id}">` +
      `<span class="step-icon">○</span>` +
      `<span class="step-name">${esc(s.name)}</span>` +
      `<span class="step-desc">${esc(s.desc)}</span>` +
      `<span class="step-result"></span>` +
    `</div>`
  ).join('');
  stepsEl.style.display = 'flex';
}

function setStep(id, state, result = '') {
  const card = document.getElementById(`step-${id}`);
  if (!card) return;
  card.className = `step-card ${state}`;
  const icon = card.querySelector('.step-icon');
  icon.innerHTML = state === 'running' ? '<span class="step-spinner"></span>'
                 : state === 'done'    ? '✓'
                 : state === 'failed'  ? '✗'
                 : '○';
  card.querySelector('.step-result').textContent = result;
}

// ── Run button ────────────────────────────────────────────────────────────────
btnRun.addEventListener('click', () => {
  const provider = selProvider.value;
  const model    = selModel.value;
  const baseUrl  = inpBaseUrl.value.trim();

  const params = new URLSearchParams({ provider });
  if (model)   params.set('model', model);
  if (baseUrl) params.set('baseUrl', baseUrl);

  btnRun.disabled = true;
  hwCards.style.display = 'none';
  lastRes.innerHTML = '';
  renderSteps();
  setStep('connect', 'running');

  const source  = new EventSource(`/api/run?${params}`);
  const results = {};

  source.addEventListener('hardware', e => {
    const hw = JSON.parse(e.data);
    hwCards.innerHTML = [
      ['CPU',   hw.cpu],
      ['Cores', hw.cpuCores],
      ['RAM',   hw.ramGb + ' GB'],
      ['GPU',   hw.gpu || 'None'],
      ['VRAM',  hw.gpuVramGb ? hw.gpuVramGb + ' GB' : '—'],
      ['OS',    hw.os],
    ].map(([label, val]) =>
      `<div class="hw-card"><div class="label">${label}</div><div class="val">${esc(String(val))}</div></div>`
    ).join('');
    hwCards.style.display = 'grid';
    setStep('connect', 'done');
  });

  source.addEventListener('progress', e => {
    const ev = JSON.parse(e.data);

    if (ev.type === 'probe_start') {
      setStep('probe', 'running');
    } else if (ev.type === 'probe_done') {
      setStep('probe', 'done', ev.hasThinking ? 'Reasoning model' : 'Standard model');
    } else if (ev.type === 'start') {
      // If probe never sent probe_done (some providers skip it), auto-complete it
      const probeCard = document.getElementById('step-probe');
      if (probeCard && probeCard.classList.contains('running')) {
        setStep('probe', 'done', 'Standard model');
      }
      setStep(ev.test, 'running');
    } else if (ev.type === 'result') {
      results[ev.test] = ev.result;
      const r = ev.result;
      if (r.success) {
        const tps  = fmt(r.tokensPerSecond);
        const ttft = Math.round(r.ttftMs) + 'ms';
        const label = ev.test === 'stress' && r.prefillToksPerSec != null
          ? `${tps} tok/s · ${ttft} · prefill ${fmt(r.prefillToksPerSec)} tok/s`
          : `${tps} tok/s · ${ttft} TTFT`;
        setStep(ev.test, 'done', label);
      } else {
        setStep(ev.test, 'failed', r.error ?? 'Failed');
      }
    }
  });

  source.addEventListener('done', () => {
    source.close();
    btnRun.disabled = false;
    renderLastResults(results);
  });

  source.addEventListener('error', e => {
    source.close();
    btnRun.disabled = false;
    const msg = e.data ? JSON.parse(e.data).message : 'Connection error';
    // Mark the first running step as failed
    for (const s of STEPS) {
      const card = document.getElementById(`step-${s.id}`);
      if (card?.classList.contains('running')) {
        setStep(s.id, 'failed', msg);
        break;
      }
    }
  });
});

function renderLastResults(results) {
  const rows = ['short', 'medium', 'long', 'stress'].map(name => {
    const r = results[name];
    if (!r) return null;
    return {
      test:    name,
      tps:     r.success ? fmt(r.tokensPerSecond) : '—',
      ttft:    r.success ? Math.round(r.ttftMs) + 'ms' : '—',
      prefill: (name === 'stress' && r.success) ? fmt(r.prefillToksPerSec) : '—',
      status:  r.success ? 'pass' : 'fail',
    };
  }).filter(Boolean);

  lastRes.innerHTML = `
    <div class="section" style="margin-top:1rem">
      <h2>Results</h2>
      ${renderRunTable(rows, [
        { key: 'test',    label: 'Test' },
        { key: 'tps',     label: 'Tok/s',        num: true },
        { key: 'ttft',    label: 'TTFT',          num: true },
        { key: 'prefill', label: 'Prefill tok/s', num: true },
        { key: 'status',  label: 'Status', render: r => chip(r.status, 'pass', 'fail') },
      ])}
    </div>`;
}

// ── History Tab ───────────────────────────────────────────────────────────────
function syncChip(synced, runId) {
  if (synced === 'yes') return '<span class="chip green">yes</span>';
  return `<button class="chip red sync-btn" data-run="${esc(runId)}" title="Click to sync to Google Sheet">no</button>`;
}

document.getElementById('history-content').addEventListener('click', async e => {
  const btn = e.target.closest('.sync-btn');
  if (!btn) return;

  const runId = btn.dataset.run;
  const row   = btn.closest('tr');
  btn.disabled = true;
  btn.textContent = '…';
  btn.classList.replace('red', 'muted');

  // Remove any previous error banner for this row
  const prev = row?.querySelector('.sync-error');
  if (prev) prev.remove();

  try {
    const res  = await fetch(`/api/push/${encodeURIComponent(runId)}`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      btn.outerHTML = '<span class="chip green">yes</span>';
    } else {
      btn.textContent = 'no';
      btn.classList.replace('muted', 'red');
      btn.disabled = false;
      showSyncError(row, data.error ?? 'Sync failed');
    }
  } catch (err) {
    btn.textContent = 'no';
    btn.classList.replace('muted', 'red');
    btn.disabled = false;
    showSyncError(row, err.message);
  }
});

function showSyncError(row, msg) {
  if (!row) return;
  const cols = row.querySelectorAll('td').length;
  const errRow = document.createElement('tr');
  errRow.innerHTML = `<td colspan="${cols}" class="sync-error" style="padding:.3rem .75rem;color:var(--red);font-size:.78rem;border-bottom:1px solid rgba(239,68,68,.2)">✗ ${esc(msg)}</td>`;
  row.after(errRow);
}

async function loadHistory() {
  const el = document.getElementById('history-content');
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const runs = await fetch('/api/local').then(r => r.json());
    if (!runs.length) { el.innerHTML = '<div class="empty">No local runs yet. Run a benchmark first.</div>'; return; }

    const rows = runs.map(r => {
      const tpsList = (r.results ?? []).filter(t => t.success && t.tokens_per_second != null).map(t => t.tokens_per_second);
      const avgTps  = tpsList.length ? (tpsList.reduce((a, b) => a + b, 0) / tpsList.length) : null;
      return {
        date:     (r.timestamp ?? '').slice(0, 16).replace('T', ' '),
        device:   r.device_name ?? r.hardware?.hostname ?? '?',
        model:    r.model,
        provider: r.provider,
        avg_tps:  avgTps != null ? avgTps.toFixed(1) : '—',
        synced:   r.synced ? 'yes' : 'no',
        run_id:   r.run_id ?? '',
      };
    });

    el.innerHTML = renderRunTable(rows, [
      { key: 'date',     label: 'Date' },
      { key: 'device',   label: 'Device' },
      { key: 'model',    label: 'Model' },
      { key: 'provider', label: 'Provider' },
      { key: 'avg_tps',  label: 'Avg tok/s', num: true },
      { key: 'synced',   label: 'Synced', render: r => syncChip(r.synced, r.run_id) },
      { key: 'run_id',   label: 'Run ID', render: r => esc(r.run_id.slice(0, 8)) },
    ]);
  } catch (err) {
    el.innerHTML = `<div class="error-banner">Failed to load history: ${esc(err.message)}</div>`;
  }
}

// ── Compare Tab ───────────────────────────────────────────────────────────────
async function loadCompare() {
  loadLocalCompare();
  loadSheetCompare();
}

async function loadLocalCompare() {
  const el = document.getElementById('local-compare');
  try {
    const runs = await fetch('/api/local').then(r => r.json());
    el.innerHTML = renderCompareTable(runs.slice(0, 10).map(localRunToRow));
  } catch (err) {
    el.innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
  }
}

async function loadSheetCompare() {
  const el = document.getElementById('sheet-compare');
  try {
    const { rows, error } = await fetch('/api/sheet').then(r => r.json());
    if (error) { el.innerHTML = `<div class="error-banner">${esc(error)}</div>`; return; }
    if (!rows?.length) { el.innerHTML = '<div class="empty">No sheet data yet.</div>'; return; }
    el.innerHTML = renderCompareTable(rows.map(sheetRowToDisplay));
  } catch (err) {
    el.innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
  }
}

function localRunToRow(r) {
  const tpsList  = (r.results ?? []).filter(t => t.success && t.tokens_per_second != null).map(t => t.tokens_per_second);
  const ttftList = (r.results ?? []).filter(t => t.success && t.ttft_ms != null).map(t => t.ttft_ms);
  const avgTps   = tpsList.length  ? (tpsList.reduce((a, b) => a + b, 0)  / tpsList.length)  : null;
  const avgTtft  = ttftList.length ? (ttftList.reduce((a, b) => a + b, 0) / ttftList.length) : null;
  return {
    device:   r.device_name ?? r.hardware?.hostname ?? '?',
    cpu:      r.hardware?.cpu ?? '?',
    gpu:      r.hardware?.gpu ?? 'None',
    model:    r.model,
    avg_tps:  avgTps  != null ? avgTps.toFixed(1)  : '—',
    avg_ttft: avgTtft != null ? Math.round(avgTtft) + 'ms' : '—',
    date:     (r.timestamp ?? '').slice(0, 10),
  };
}

function sheetRowToDisplay(r) {
  return {
    device:   r.device_name || r.device_id?.slice(0, 8) || '?',
    cpu:      r.cpu  || '?',
    gpu:      r.gpu  || 'None',
    model:    r.model || '?',
    avg_tps:  r.avg_tps     ? Number(r.avg_tps).toFixed(1)     : '—',
    avg_ttft: r.avg_ttft_ms ? Math.round(r.avg_ttft_ms) + 'ms' : '—',
    date:     (r.timestamp ?? '').slice(0, 10),
  };
}

function renderCompareTable(rows) {
  if (!rows.length) return '<div class="empty">No data.</div>';
  return renderRunTable(rows, [
    { key: 'device',   label: 'Device' },
    { key: 'cpu',      label: 'CPU' },
    { key: 'gpu',      label: 'GPU' },
    { key: 'model',    label: 'Model' },
    { key: 'avg_tps',  label: 'Avg tok/s', num: true },
    { key: 'avg_ttft', label: 'Avg TTFT',  num: true },
    { key: 'date',     label: 'Date' },
  ]);
}

// ── Join code helpers ─────────────────────────────────────────────────────────
function encodeJoinCode(clientId, clientSecret, sheetsId) {
  return 'aib_' + btoa(JSON.stringify({ c: clientId, s: clientSecret || '', d: sheetsId }));
}

function decodeJoinCode(code) {
  try {
    const raw = code.trim().startsWith('aib_') ? code.trim().slice(4) : code.trim();
    const { c, s, d } = JSON.parse(atob(raw));
    if (!c || !d) return null;
    return { clientId: c, clientSecret: s || '', sheetsId: d };
  } catch {
    return null;
  }
}

// ── Settings Tab ──────────────────────────────────────────────────────────────
let _settingsData = {};

async function loadSettings() {
  const resultEl   = document.getElementById('settings-result');
  const progressEl = document.getElementById('auth-progress');
  const stripEl    = document.getElementById('oauth-status-strip');
  resultEl.innerHTML = '';
  progressEl.innerHTML = '';

  try {
    const data = await fetch('/api/settings').then(r => r.json());
    _settingsData = data;

    document.getElementById('set-device-name').value = data.deviceName ?? '';
    document.getElementById('set-sheet-url').value   = data.sheetsId   ?? '';

    if (data.hasCredentials) {
      document.getElementById('cred-saved-row').style.display  = 'block';
      document.getElementById('cred-section').style.display    = 'none';
      document.getElementById('set-client-id').value           = data.googleClientId ?? '';
      document.getElementById('set-client-secret').placeholder = '(saved)';
    } else {
      document.getElementById('cred-saved-row').style.display = 'none';
      document.getElementById('cred-section').style.display   = 'block';
    }

    document.getElementById('btn-copy-join-code').style.display =
      (data.hasCredentials && data.sheetsId) ? 'inline-block' : 'none';

    const authorizeBtn = document.getElementById('btn-authorize');
    if (data.hasToken) {
      stripEl.innerHTML = '<div class="status-pill ok">✓ Google Sheets authorized</div>';
      authorizeBtn.textContent = '↻ Re-authorize';
      authorizeBtn.disabled    = false;
    } else if (data.hasCredentials) {
      stripEl.innerHTML = '<div class="status-pill warn">Credentials saved — click Authorize to connect Google Sheets</div>';
      authorizeBtn.textContent = 'Authorize Google Sheets';
      authorizeBtn.disabled    = false;
    } else {
      stripEl.innerHTML = '';
      authorizeBtn.disabled = true;
    }
  } catch (err) {
    resultEl.innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
  }
}

function copyJoinCode() {
  const { googleClientId, googleClientSecret, sheetsId } = _settingsData;
  if (!googleClientId || !sheetsId) return;
  const code = encodeJoinCode(googleClientId, googleClientSecret, sheetsId);
  const btn  = document.getElementById('btn-copy-join-code');
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = 'Copy Join Code'; }, 2000);
  });
}

function onSettingsJoinCode() {
  const code     = document.getElementById('set-join-code').value.trim();
  const resultEl = document.getElementById('join-code-decode-result');
  if (!code) { resultEl.innerHTML = ''; return; }
  const decoded = decodeJoinCode(code);
  if (decoded) {
    document.getElementById('set-sheet-url').value    = decoded.sheetsId;
    document.getElementById('set-client-id').value    = decoded.clientId;
    document.getElementById('set-client-secret').value = decoded.clientSecret;
    // Show credential fields so the user can see what will be saved
    document.getElementById('cred-section').style.display   = 'block';
    document.getElementById('cred-saved-row').style.display = 'none';
    resultEl.innerHTML = '<div class="status-pill ok">✓ Join code recognised — review credentials below and click Save Settings</div>';
  } else {
    resultEl.innerHTML = '<div class="status-pill warn">Invalid join code</div>';
  }
}

function showCredFields() {
  document.getElementById('cred-saved-row').style.display = 'none';
  document.getElementById('cred-section').style.display   = 'block';
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const btn      = document.getElementById('btn-save-settings');
  const resultEl = document.getElementById('settings-result');

  btn.disabled    = true;
  btn.textContent = 'Saving…';
  resultEl.innerHTML = '';

  try {
    const body = {};
    const devName   = document.getElementById('set-device-name').value.trim();
    const sheetUrl  = document.getElementById('set-sheet-url').value.trim();
    const clientId  = document.getElementById('set-client-id').value.trim();
    const clientSec = document.getElementById('set-client-secret').value.trim();
    const joinCode  = document.getElementById('set-join-code').value.trim();

    // Join code takes priority — decode credentials + sheet ID from it
    const joinDecoded = joinCode ? decodeJoinCode(joinCode) : null;

    if (devName)                   body.deviceName         = devName;
    if (joinDecoded?.sheetsId)     body.sheetsId           = joinDecoded.sheetsId;
    else if (sheetUrl)             body.sheetsId           = sheetUrl;
    if (joinDecoded?.clientId)     body.googleClientId     = joinDecoded.clientId;
    else if (clientId)             body.googleClientId     = clientId;
    if (joinDecoded?.clientSecret) body.googleClientSecret = joinDecoded.clientSecret;
    else if (clientSec)            body.googleClientSecret = clientSec;

    const res = await fetch('/api/settings/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      resultEl.innerHTML = '<div class="status-pill ok">✓ Settings saved</div>';
      loadSettings();
    } else {
      resultEl.innerHTML = `<div class="error-banner">${esc(data.error ?? 'Save failed')}</div>`;
    }
  } catch (err) {
    resultEl.innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
  }

  btn.disabled    = false;
  btn.textContent = 'Save Settings';
});

document.getElementById('btn-authorize').addEventListener('click', async () => {
  const btn        = document.getElementById('btn-authorize');
  const progressEl = document.getElementById('auth-progress');

  btn.disabled = true;
  progressEl.innerHTML = '<div class="status-pill warn">Opening browser for Google authorization… complete sign-in then return here. This may take up to a minute.</div>';

  try {
    const res  = await fetch('/api/settings/authorize', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      progressEl.innerHTML = '<div class="status-pill ok">✓ Google Sheets authorized successfully!</div>';
      loadSettings();
    } else {
      progressEl.innerHTML = `<div class="error-banner">${esc(data.error ?? 'Authorization failed')}</div>`;
      btn.disabled = false;
    }
  } catch (err) {
    progressEl.innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
    btn.disabled = false;
  }
});
