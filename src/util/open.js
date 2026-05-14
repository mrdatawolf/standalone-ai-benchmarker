import { spawn } from 'node:child_process';

export function openUrl(url) {
  try {
    if (process.platform === 'win32') {
      // rundll32 opens URLs via the Windows shell API without cmd.exe metacharacter issues
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
  } catch { /* non-fatal — user can open manually */ }
}
