import { google } from 'googleapis';
import { getAuthClient } from './auth.js';
import { config } from '../config.js';

const SHEET_RUNS = 'runs';

const HEADERS = [
  'timestamp', 'run_id', 'device_id', 'device_name',
  'os', 'cpu', 'cpu_cores', 'ram_gb', 'gpu', 'gpu_vram_gb',
  'provider', 'model',
  'test_short_tps', 'test_short_ttft_ms',
  'test_medium_tps', 'test_medium_ttft_ms',
  'test_long_tps', 'test_long_ttft_ms',
  'test_stress_prefill_tps',
  'avg_tps', 'avg_ttft_ms',
  'cold_start', 'is_reasoning'
];

function _getSheetId() {
  if (!config.sheetsId) {
    throw new Error('Google Sheet not configured. Run: ai-bench config --sheet <url>');
  }
  return config.sheetsId;
}

function _getSheetsClient(auth) {
  return google.sheets({ version: 'v4', auth });
}

async function _ensureHeaders(sheets, spreadsheetId) {
  // Create the 'runs' tab if it doesn't exist
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabExists = meta.data.sheets?.some(s => s.properties.title === SHEET_RUNS);
  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_RUNS } } }] },
    });
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_RUNS}!A1:Z1`,
  });
  const existing = res.data.values?.[0] ?? [];
  if (existing.length === 0 || existing[0] !== 'timestamp') {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range:            `${SHEET_RUNS}!A1`,
      valueInputOption: 'RAW',
      requestBody:      { values: [HEADERS] },
    });
  }
}

export function runToRow(run) {
  const hw = run.hardware;
  const getTest = name => run.results.find(r => (r.test_name ?? r.testName) === name);

  const short  = getTest('short');
  const medium = getTest('medium');
  const long   = getTest('long');
  const stress = getTest('stress');

  const tpsList   = [short, medium, long].filter(t => t?.success && (t.tokens_per_second ?? t.tokensPerSecond) != null).map(t => t.tokens_per_second ?? t.tokensPerSecond);
  const ttftList  = [short, medium, long].filter(t => t?.success && (t.ttft_ms ?? t.ttftMs) != null).map(t => t.ttft_ms ?? t.ttftMs);
  const avgTps    = tpsList.length  ? parseFloat((tpsList.reduce((a, b) => a + b, 0) / tpsList.length).toFixed(2))  : '';
  const avgTtft   = ttftList.length ? Math.round(ttftList.reduce((a, b) => a + b, 0) / ttftList.length) : '';
  const coldStart = (run.warnings ?? []).some(w => w.type === 'cold_start');

  const v = (t, field, fallback) => t?.success ? (t[field] ?? '') : (fallback ?? '');

  return [
    run.timestamp,
    run.run_id,
    run.device_id,
    run.device_name ?? hw.hostname ?? '',
    hw.os   ?? '',
    hw.cpu  ?? '',
    hw.cpuCores ?? '',
    hw.ramGb ?? '',
    hw.gpu ?? '',
    hw.gpuVramGb ?? '',
    run.provider,
    run.model,
    v(short,  'tokens_per_second') || v(short,  'tokensPerSecond'),
    v(short,  'ttft_ms')           || v(short,  'ttftMs'),
    v(medium, 'tokens_per_second') || v(medium, 'tokensPerSecond'),
    v(medium, 'ttft_ms')           || v(medium, 'ttftMs'),
    v(long,   'tokens_per_second') || v(long,   'tokensPerSecond'),
    v(long,   'ttft_ms')           || v(long,   'ttftMs'),
    v(stress, 'prefill_toks_per_second') || v(stress, 'prefillToksPerSec'),
    avgTps,
    avgTtft,
    coldStart          ? 'yes' : 'no',
    run.is_reasoning   ? 'yes' : 'no',
  ];
}

export async function pushRun(run) {
  const spreadsheetId = _getSheetId();
  const auth   = await getAuthClient();
  const sheets = _getSheetsClient(auth);

  await _ensureHeaders(sheets, spreadsheetId);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range:            `${SHEET_RUNS}!A:A`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: [runToRow(run)] },
  });
}

export async function fetchAllRuns() {
  const spreadsheetId = _getSheetId();
  const auth   = await getAuthClient();
  const sheets = _getSheetsClient(auth);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_RUNS}!A:Z`,
  });

  const rows = res.data.values ?? [];
  if (rows.length < 2) return [];

  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] ?? ''; });
    return obj;
  });
}
