import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { config as loadDotenv } from 'dotenv';

export const DATA_DIR = join(homedir(), '.ai-bench');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Load .env from: next to exe (pkg), cwd, or ~/.ai-bench/
function findAndLoadEnv() {
  const candidates = [join(DATA_DIR, '.env'), join(process.cwd(), '.env')];
  if (process.pkg) candidates.unshift(join(dirname(process.execPath), '.env'));
  for (const p of candidates) {
    if (existsSync(p)) { loadDotenv({ path: p }); return; }
  }
  loadDotenv(); // fallback: try cwd/.env via dotenv default
}
findAndLoadEnv();

function extractSheetId(urlOrId) {
  if (!urlOrId) return null;
  const match = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : urlOrId;
}

const CONFIG_FILE = join(DATA_DIR, 'config.json');

export function getUserConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

export function saveUserConfig(updates) {
  const updated = { ...getUserConfig(), ...updates };
  writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
  return updated;
}

const _user = getUserConfig();

export const config = {
  sheetsId: extractSheetId(process.env.SHEETS_URL ?? process.env.SHEETS_ID ?? _user.sheetsId ?? null),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? _user.googleClientId ?? null,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? _user.googleClientSecret ?? null,
  defaultProvider: process.env.AI_PROVIDER ?? _user.defaultProvider ?? 'ollama',
  defaultModel: process.env.AI_MODEL ?? _user.defaultModel ?? null,
  defaultBaseUrl: process.env.AI_BASE_URL ?? _user.defaultBaseUrl ?? null,
  deviceName: _user.deviceName ?? null,
  deviceId: _user.deviceId ?? null,
  port: parseInt(process.env.PORT ?? '3751', 10),
};
