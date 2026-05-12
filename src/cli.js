#!/usr/bin/env node
import { program } from 'commander';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { runBenchmark } from './benchmark/engine.js';
import { getHardwareInfo } from './benchmark/hardware.js';
import { saveRun, getRuns, getRunById, markSynced, getUnsyncedRuns } from './storage/operations.js';
import { pushRun, fetchAllRuns } from './sheets/client.js';
import { config, getUserConfig, saveUserConfig } from './config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n, decimals = 1) {
  return n == null ? '—' : Number(n).toFixed(decimals);
}

function printTable(rows, cols) {
  const widths = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(r[c.key] ?? '—').length)));
  const sep    = widths.map(w => '─'.repeat(w + 2)).join('┼');
  const header = cols.map((c, i) => ` ${c.label.padEnd(widths[i])} `).join('│');
  console.log('┌' + sep.replace(/┼/g, '┬') + '┐');
  console.log('│' + header + '│');
  console.log('├' + sep + '┤');
  for (const row of rows) {
    const line = cols.map((c, i) => ` ${String(row[c.key] ?? '—').padEnd(widths[i])} `).join('│');
    console.log('│' + line + '│');
  }
  console.log('└' + sep.replace(/┼/g, '┴') + '┘');
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function ensureDeviceId() {
  if (config.deviceId) return config.deviceId;
  const id = randomUUID();
  saveUserConfig({ deviceId: id });
  config.deviceId = id;
  return id;
}

function printBenchProgress(event) {
  switch (event.type) {
    case 'probe_start':
      process.stdout.write('  Probing model... ');
      break;
    case 'probe_done':
      process.stdout.write(event.hasThinking ? 'reasoning model detected\n' : 'ok\n');
      break;
    case 'start':
      process.stdout.write(`  [${event.test}] ${event.label}... `);
      break;
    case 'result': {
      const r = event.result;
      if (r.success) {
        process.stdout.write(`${fmt(r.tokensPerSecond)} tok/s  TTFT ${fmt(r.ttftMs, 0)}ms\n`);
      } else {
        process.stdout.write(`FAILED — ${r.error}\n`);
      }
      break;
    }
  }
}

// ── run ───────────────────────────────────────────────────────────────────────

function printFirstRunHint() {
  const uc = getUserConfig();
  if (uc.setupComplete) return;
  console.log('');
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│  First time? Run the setup wizard for a guided tour:    │');
  console.log('│                                                         │');
  console.log('│    node src/cli.js compare                              │');
  console.log('│                                                         │');
  console.log('│  Or continue running directly — no setup required.     │');
  console.log('└─────────────────────────────────────────────────────────┘');
  console.log('');
}

program
  .command('run')
  .description('Benchmark a local AI provider and save results')
  .option('--provider <type>',   'ollama | llamacpp | custom',    config.defaultProvider ?? 'ollama')
  .option('--model <name>',      'Model name',                    config.defaultModel    ?? undefined)
  .option('--base-url <url>',    'Provider base URL',             config.defaultBaseUrl  ?? undefined)
  .option('--no-push',           'Skip pushing results to Google Sheet')
  .option('--device-name <name>','Override device display name')
  .action(async (opts) => {
    printFirstRunHint();
    const deviceId   = ensureDeviceId();
    const deviceName = opts.deviceName ?? config.deviceName ?? null;

    console.log(`\nCollecting hardware info...`);
    const hardware = await getHardwareInfo();
    console.log(`  ${hardware.cpu}  |  ${hardware.ramGb}GB RAM  |  ${hardware.gpu ?? 'No GPU'}`);

    console.log(`\nRunning benchmark — ${opts.provider} / ${opts.model ?? 'default model'}`);
    console.log('─'.repeat(60));

    let benchResult;
    try {
      benchResult = await runBenchmark({
        onProgress:   printBenchProgress,
        providerType: opts.provider,
        baseUrl:      opts.baseUrl,
        model:        opts.model,
      });
    } catch (err) {
      console.error('\nBenchmark failed:', err.message);
      process.exit(1);
    }

    console.log('─'.repeat(60));

    // Print warnings
    for (const w of benchResult.warnings) {
      console.log(`\nWARNING (${w.type}): ${w.message}`);
      if (w.suggestedModels) {
        console.log('  Suggested alternatives:', w.suggestedModels.slice(0, 5).join(', '));
      }
    }

    // Print suitability
    console.log('\nSuitability:');
    for (const [task, verdict] of Object.entries(benchResult.suitability)) {
      if (task.startsWith('_')) continue;
      const icon = verdict.ok === true ? '✓' : verdict.ok === false ? '✗' : '?';
      console.log(`  ${icon} ${task}: ${verdict.reason ?? 'pass'}`);
    }

    const timestamp = new Date().toISOString();
    saveRun({
      runId:       benchResult.runId,
      timestamp,
      deviceId,
      deviceName,
      hardware,
      provider:    benchResult.provider,
      model:       benchResult.model,
      suitability: benchResult.suitability,
      warnings:    benchResult.warnings,
      isReasoning: benchResult.isReasoning,
      results:     benchResult.results,
    });
    console.log(`\nSaved locally (run_id: ${benchResult.runId})`);

    if (opts.push !== false) {
      if (!config.sheetsId) {
        console.log('\nGoogle Sheet not configured — skipping sync. Run: ai-bench config --sheet <url>');
      } else {
        console.log('Pushing to Google Sheet...');
        try {
          const fullRun = {
            ...benchResult,
            timestamp, deviceId, deviceName, hardware,
            results: benchResult.results,
          };
          await pushRun(fullRun);
          markSynced(benchResult.runId);
          console.log('Done.');
        } catch (err) {
          console.error('Sheet sync failed:', err.message);
          console.log('Run `ai-bench push` later to retry.');
        }
      }
    }

    console.log('');
  });

// ── history ────────────────────────────────────────────────────────────────

program
  .command('history')
  .description('Show local benchmark history')
  .option('--limit <n>', 'Number of runs to show', '10')
  .action((opts) => {
    const runs = getRuns(parseInt(opts.limit, 10));
    if (runs.length === 0) { console.log('No local runs yet.'); return; }

    const rows = runs.map(r => {
      const tpsList = r.results.filter(t => t.success && t.tokens_per_second != null).map(t => t.tokens_per_second);
      const avgTps  = tpsList.length ? (tpsList.reduce((a, b) => a + b, 0) / tpsList.length).toFixed(1) : '—';
      return {
        date:     r.timestamp.slice(0, 16).replace('T', ' '),
        device:   r.device_name ?? r.hardware.hostname ?? '?',
        provider: r.provider,
        model:    r.model.length > 22 ? r.model.slice(0, 21) + '…' : r.model,
        avg_tps:  avgTps,
        synced:   r.synced ? 'yes' : 'no',
        run_id:   r.run_id.slice(0, 8),
      };
    });

    console.log('');
    printTable(rows, [
      { key: 'date',     label: 'Date' },
      { key: 'device',   label: 'Device' },
      { key: 'provider', label: 'Provider' },
      { key: 'model',    label: 'Model' },
      { key: 'avg_tps',  label: 'Avg tok/s' },
      { key: 'synced',   label: 'Synced' },
      { key: 'run_id',   label: 'Run ID' },
    ]);
    console.log('');
  });

// ── push ──────────────────────────────────────────────────────────────────

program
  .command('push [run-id]')
  .description('Push local run(s) to Google Sheet. Omit run-id to push all unsynced runs.')
  .action(async (runId) => {
    const runs = runId ? [getRunById(runId)].filter(Boolean) : getUnsyncedRuns();
    if (runs.length === 0) { console.log('Nothing to push.'); return; }

    console.log(`Pushing ${runs.length} run(s) to Google Sheet...`);
    let ok = 0;
    for (const run of runs) {
      try {
        await pushRun(run);
        markSynced(run.run_id);
        ok++;
        console.log(`  ✓ ${run.run_id.slice(0, 8)}  ${run.model}`);
      } catch (err) {
        console.error(`  ✗ ${run.run_id.slice(0, 8)} — ${err.message}`);
      }
    }
    console.log(`\n${ok}/${runs.length} pushed.`);
  });

// ── compare ────────────────────────────────────────────────────────────────

program
  .command('compare')
  .description('Open browser viewer to compare local and sheet results')
  .option('--port <n>', 'Port for local viewer', String(config.port))
  .action(async (opts) => {
    const { startViewer } = await import('./web/server.js');
    const port = parseInt(opts.port, 10);
    await startViewer(port);
  });

// ── config ─────────────────────────────────────────────────────────────────

program
  .command('config')
  .description('Configure ai-bench settings')
  .option('--sheet <url>',                'Google Sheet URL or ID')
  .option('--device-name <name>',         'Display name for this device')
  .option('--default-provider <type>',    'Default provider (ollama|llamacpp|custom)')
  .option('--default-model <name>',       'Default model name')
  .option('--default-base-url <url>',     'Default provider base URL')
  .option('--google-client-id <id>',      'Google OAuth2 Client ID')
  .option('--google-client-secret <sec>', 'Google OAuth2 Client Secret')
  .option('--show',                       'Print current configuration')
  .action(async (opts) => {
    if (opts.show) {
      const cfg = getUserConfig();
      console.log('\nCurrent config (~/.ai-bench/config.json):');
      console.log(JSON.stringify(cfg, null, 2));
      console.log('');
      return;
    }

    const updates = {};

    if (opts.sheet) {
      const match = opts.sheet.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      updates.sheetsId = match ? match[1] : opts.sheet;
      console.log('Sheet ID set to:', updates.sheetsId);
    }
    if (opts.deviceName)        updates.deviceName         = opts.deviceName;
    if (opts.defaultProvider)   updates.defaultProvider    = opts.defaultProvider;
    if (opts.defaultModel)      updates.defaultModel       = opts.defaultModel;
    if (opts.defaultBaseUrl)    updates.defaultBaseUrl     = opts.defaultBaseUrl;
    if (opts.googleClientId)    updates.googleClientId     = opts.googleClientId;
    if (opts.googleClientSecret) updates.googleClientSecret = opts.googleClientSecret;

    if (Object.keys(updates).length === 0) {
      // Interactive setup
      console.log('\nInteractive setup (press Enter to keep current value)\n');

      const current = getUserConfig();

      const sheetInput = await prompt(`Google Sheet URL or ID [${current.sheetsId ?? 'not set'}]: `);
      if (sheetInput) {
        const match = sheetInput.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        updates.sheetsId = match ? match[1] : sheetInput;
      }

      const name = await prompt(`Device display name [${current.deviceName ?? config.deviceId ?? 'auto'}]: `);
      if (name) updates.deviceName = name;

      const provider = await prompt(`Default provider [${current.defaultProvider ?? 'ollama'}]: `);
      if (provider) updates.defaultProvider = provider;

      const model = await prompt(`Default model [${current.defaultModel ?? 'provider default'}]: `);
      if (model) updates.defaultModel = model;

      const hasGoogle = current.googleClientId && current.googleClientSecret;
      const setupGoogle = await prompt(`Set up Google OAuth credentials? ${hasGoogle ? '[already set, y to replace]' : '[y/N]'}: `);
      if (setupGoogle.toLowerCase() === 'y') {
        console.log('\nGet credentials at: console.cloud.google.com');
        console.log('APIs & Services → Credentials → Create → OAuth client ID → Desktop app\n');
        updates.googleClientId     = await prompt('Client ID: ');
        updates.googleClientSecret = await prompt('Client Secret: ');
      }
    }

    if (Object.keys(updates).length > 0) {
      saveUserConfig(updates);
      console.log('\nConfiguration saved to ~/.ai-bench/config.json');
    } else {
      console.log('No changes made.');
    }
  });

// No command → start the web viewer (the primary UX)
if (process.argv.length <= 2) {
  import('./web/server.js').then(({ startViewer }) => startViewer(config.port ?? 3751));
} else {
  program.parse();
}
