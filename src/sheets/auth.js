import { google } from 'googleapis';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openUrl } from '../util/open.js';
import { DATA_DIR, getUserConfig } from '../config.js';

const TOKEN_PATH  = join(DATA_DIR, 'token.json');
const REDIRECT    = 'http://localhost:3729/oauth2callback';
const SCOPES      = ['https://www.googleapis.com/auth/spreadsheets'];

export function createOAuth2Client() {
  const uc = getUserConfig();
  const clientId     = (process.env.GOOGLE_CLIENT_ID?.trim()     || uc.googleClientId?.trim())     || null;
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET?.trim() || uc.googleClientSecret?.trim()) || null;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth2 credentials not configured.\n' +
      'Open the Settings tab and enter your Google Client ID and Secret.\n\n' +
      'To get credentials: console.cloud.google.com → APIs & Services → Credentials\n' +
      '  → Create Credentials → OAuth client ID → Desktop app'
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT);
}

export function hasValidToken() {
  const saved = loadSavedToken();
  return !!saved && (!saved.expiry_date || saved.expiry_date > Date.now());
}

function loadSavedToken() {
  if (!existsSync(TOKEN_PATH)) return null;
  try { return JSON.parse(readFileSync(TOKEN_PATH, 'utf8')); }
  catch { return null; }
}

function saveToken(token) {
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

export async function getAuthClient() {
  const oauth2 = createOAuth2Client();
  const saved  = loadSavedToken();

  if (saved) {
    oauth2.setCredentials(saved);
    // Refresh if expiring within 60 s
    if (saved.expiry_date && saved.expiry_date < Date.now() + 60_000) {
      try {
        const { credentials } = await oauth2.refreshAccessToken();
        saveToken(credentials);
        oauth2.setCredentials(credentials);
      } catch {
        return _authorizeNew(oauth2);
      }
    }
    return oauth2;
  }

  return _authorizeNew(oauth2);
}

async function _authorizeNew(oauth2) {
  const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });

  console.log('\nOpening Google authorization in your browser...');
  console.log('If the browser does not open, visit:\n' + authUrl + '\n');

  const code = await _captureCode(authUrl);
  const { tokens } = await oauth2.getToken(code);
  saveToken(tokens);
  oauth2.setCredentials(tokens);
  console.log('Authorization complete. Token saved to ' + TOKEN_PATH + '\n');
  return oauth2;
}

function _captureCode(authUrl) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url   = new URL(req.url, 'http://localhost:3729');
      if (url.pathname !== '/oauth2callback') return;

      const code  = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;padding:40px;background:#0f1117;color:#e2e8f0"><h2 style="color:#22c55e">&#10003; Authorization successful</h2><p style="margin-top:.75rem;color:#8892aa">You can close this tab and return to AI Bench.</p></body></html>');
      server.close();

      if (code) resolve(code);
      else reject(new Error(error ?? 'No authorization code received'));
    });

    server.listen(3729, '127.0.0.1', () => { openUrl(authUrl); });

    server.on('error', reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth2 authorization timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}
