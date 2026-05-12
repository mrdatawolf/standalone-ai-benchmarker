// Benchmark engine — ported from project-brain/src/ai/benchmark.js.
// DB calls removed; caller receives all results and decides what to store.

import { createProvider } from './providers.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

// ~3500-token input to stress prefill speed. Minimal output so the result is
// almost entirely TTFT — the metric that most clearly separates GPU from CPU.
const STRESS_PROMPT =
`Project: multi-user-timesheet — Multi-tenant employee time tracking for NFL and corporate clients.

PR #52: Refactor database layer to connection pooling, add audit logging, migrate attendance to fractional hours

## Summary
Replaces the single shared db client with pg-pool (max 20 connections), introduces an audit_log table for compliance, and migrates attendance_entries to store hours as NUMERIC(6,2) rather than INTEGER. All changes are backwards-compatible; the legacy integer hours column is retained and auto-backfilled.

## Files changed

### src/db/pool.ts (new)
\`\`\`typescript
import { Pool, PoolClient } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
pool.on('error', (err) => { console.error('Idle client error', err); process.exit(-1); });

export async function withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
\`\`\`

### src/db/audit.ts (new)
\`\`\`typescript
import { PoolClient } from 'pg';
import { pool } from './pool';

export type AuditAction =
  | 'attendance.create' | 'attendance.update' | 'attendance.delete'
  | 'timesheet.submit'  | 'timesheet.approve' | 'timesheet.reject'
  | 'user.login'        | 'user.logout'        | 'report.generate';

export interface AuditEntry {
  userId: string;
  action: AuditAction;
  entityType: string;
  entityId: string | number;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export async function writeAuditLog(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    \`INSERT INTO audit_log
       (user_id, action, entity_type, entity_id, previous_value, new_value, metadata, ip_address, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())\`,
    [entry.userId, entry.action, entry.entityType, entry.entityId,
     entry.previousValue ? JSON.stringify(entry.previousValue) : null,
     entry.newValue      ? JSON.stringify(entry.newValue)      : null,
     entry.metadata      ? JSON.stringify(entry.metadata)      : null,
     entry.ipAddress ?? null]
  );
}
\`\`\`

### src/db/migrations/0048_pool_audit_fractional_hours.sql (new)
\`\`\`sql
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  previous_value JSONB,
  new_value      JSONB,
  metadata       JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_entity  ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_user    ON audit_log(user_id);
CREATE INDEX idx_audit_action  ON audit_log(action);
CREATE INDEX idx_audit_created ON audit_log(created_at);

ALTER TABLE attendance_entries
  ADD COLUMN IF NOT EXISTS hours_decimal  NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC(6,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_approved    BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by    TEXT,
  ADD COLUMN IF NOT EXISTS approved_at    TIMESTAMPTZ;

UPDATE attendance_entries
  SET hours_decimal = CAST(hours AS NUMERIC(6,2))
  WHERE hours_decimal IS NULL AND hours IS NOT NULL;

ALTER TABLE attendance_entries
  ADD CONSTRAINT chk_hours_decimal_positive CHECK (hours_decimal >= 0),
  ADD CONSTRAINT chk_overtime_positive      CHECK (overtime_hours >= 0);
\`\`\`

### src/api/attendance/route.ts (modified)
**Before:** bare db.query with integer hours, no input validation, no audit trail.

**After:**
\`\`\`typescript
import { withTransaction } from '../../db/pool';
import { writeAuditLog }   from '../../db/audit';
import { validateAttendanceEntry } from './validators';
import { Router } from 'express';

const router = Router();

router.post('/', async (req, res) => {
  const v = validateAttendanceEntry(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const entry = await withTransaction(async (client) => {
      const { rows } = await client.query(
        \`INSERT INTO attendance_entries (user_id, date, hours_decimal, time_code_id, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING *\`,
        [req.body.userId, req.body.date, req.body.hoursDecimal, req.body.timeCodeId, req.body.notes]
      );
      await writeAuditLog(client, {
        userId: req.user.id, action: 'attendance.create',
        entityType: 'attendance_entries', entityId: rows[0].id,
        newValue: rows[0], ipAddress: req.ip,
      });
      return rows[0];
    });
    res.json(entry);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
\`\`\`

## Migration notes
- All ALTER TABLE statements use IF NOT EXISTS — safe to run multiple times
- Backfill query is idempotent (WHERE hours_decimal IS NULL)
- Pool load test: 50 concurrent requests, p99 latency 43 ms, zero pool exhaustion events`;

const TESTS = [
  {
    name: 'short',
    label: 'Short completion',
    description: '~50 token input, 1-sentence output',
    messages: [
      { role: 'system', content: 'You are a concise assistant. Respond in one sentence only.' },
      { role: 'user',   content: 'What is a pull request in software development?' }
    ],
    maxTokens: 60,
    tasks: ['pr-expand']
  },
  {
    name: 'medium',
    label: 'PR expansion',
    description: '~300 token input, 2-3 sentence output',
    messages: [
      { role: 'system', content: 'You are a technical writer. Summarize the following pull request for a work report in 2-3 sentences.' },
      { role: 'user',   content: 'Project: multi-user-timesheet\n\nPR #47: Fix broken report queries and NFL attendance improvements\n\nBody: Fixed broken report queries in attendance-management/route.ts, reports/route.ts, and queries-sqlite.ts which were joining on time_code_id which does not exist in the attendance_entries table. Added accrual-based vacation calculations. Config-driven sick leave availability text replaced hardcoded map. Fixed NFL Personal (PERS) allocation from 40 to null. Version bump 1.7.4 to 1.7.5.' }
    ],
    maxTokens: 300,
    tasks: ['pr-expand']
  },
  {
    name: 'long',
    label: 'Report section',
    description: '~1500 token input, multi-paragraph output',
    messages: [
      { role: 'system', content: 'You are a technical writer preparing a professional client-facing work report. Write clear, concise summaries suitable for invoicing.' },
      { role: 'user',   content: 'Client: LCIT\nPeriod: April 28 - May 2, 2026\n\nProject: multi-user-timesheet\n\nPR #46: fixes the electron app adding a tray icon when not using break system\nExpanded: The Electron app no longer adds a tray icon when the break system is not in use.\n\nPR #45: Update NFL user logout and timecode handling\nBody: New rule to allow the system to auto generate the user abbreviation. New rule to logout NFL users on close. Update LA and LE to have unlimited use. Time code reorder and cleanup.\n\nPR #44: now a build properly resets static also\nExpanded: The build now properly resets static assets during the process.\n\nPR #43: Add BT tray break and lunch controls\nBody: Adds BT-only tray icons for lunch and break reminders, enforces configured break windows, and fixes Electron local startup.\n\nPR #42: fixing year change when brand has mid year start dates\nExpanded: The system now correctly handles year changes during the brand holiday start date adjustment.\n\nPR #41: added new absences to NFL\nBody: also fixed display issues\n\nProject: project-brain\n\nPR #2: Add GitHub repo scanning, enhanced web UI, and CRUD routes\nBody: Added GitHub repository scanning with metadata detection. Built enhanced web UI with sidebar navigation. Implemented full CRUD API routes for all entities.\n\nWrite a professional 3-4 paragraph summary of the week\'s work suitable for a client invoice.' }
    ],
    maxTokens: 400,
    tasks: ['pr-expand', 'report']
  },
  {
    name: 'stress',
    label: 'Long context (prefill)',
    description: '~3500 token input, 1-sentence output — isolates prefill speed to reveal GPU vs CPU gap',
    messages: [
      { role: 'system', content: 'You are a technical writer. Summarize the following pull request in exactly one sentence.' },
      { role: 'user',   content: STRESS_PROMPT }
    ],
    maxTokens: 80,
    tasks: []
  }
];

export const TASK_LABELS = { 'pr-expand': 'PR Expansion', 'report': 'Report Generation' };

// Floor a mid-range consumer GPU (RTX 3070) achieves on heavy long-context prompts.
const THRESHOLDS = {
  'pr-expand': { minToksPerSec: 1.5 },
  'report':    { minToksPerSec: 1.0 }
};

const REASONING_PATTERNS = ['deepseek-r1', 'deepseek-r2', 'qwq'];
const FALLBACK_INSTRUCT_SUGGESTIONS = ['llama3.2:3b', 'llama3.1:8b', 'qwen2.5:7b', 'mistral:7b', 'phi3.5:mini'];

export function isReasoningModel(model) {
  const m = (model ?? '').toLowerCase();
  return REASONING_PATTERNS.some(p => m.includes(p));
}

/**
 * Run the full benchmark suite against a local provider.
 *
 * @param {object} opts
 * @param {function} [opts.onProgress]   Called with SSE-style event objects during the run
 * @param {string}  [opts.providerType]  'ollama' | 'llamacpp' | 'custom'
 * @param {string}  [opts.baseUrl]       Provider base URL (overrides .env)
 * @param {string}  [opts.model]         Model name (overrides .env)
 */
export async function runBenchmark({ onProgress, providerType, baseUrl, model } = {}) {
  const runId            = randomUUID();
  const effectiveType    = providerType ?? config.defaultProvider ?? 'ollama';
  const effectiveModel   = model   ?? config.defaultModel   ?? undefined;
  const effectiveBaseUrl = baseUrl ?? config.defaultBaseUrl ?? undefined;

  const provider = createProvider({ providerType: effectiveType, baseUrl: effectiveBaseUrl, model: effectiveModel });
  const resolvedModel = provider.model;

  // Probe: detect reasoning/thinking models before timed tests
  let detectedReasoning = isReasoningModel(resolvedModel);
  if (!detectedReasoning) {
    onProgress?.({ type: 'probe_start' });
    try {
      const { hasThinking, rawText } = await provider.probe();
      detectedReasoning = hasThinking;
      onProgress?.({ type: 'probe_done', hasThinking, rawPreview: rawText.slice(0, 120) });
    } catch (err) {
      onProgress?.({ type: 'probe_done', hasThinking: false, error: err.message });
    }
  }

  const results = [];

  for (const test of TESTS) {
    onProgress?.({ type: 'start', test: test.name, label: test.label });
    let result;
    try {
      const m = await provider.chatWithMetrics(test.messages, { maxTokens: test.maxTokens });

      const ttftMs          = m.tFirstToken - m.tStart;
      const totalMs         = m.tEnd - m.tStart;
      const tokensPerSecond = m.completionTokens
        ? parseFloat((m.completionTokens / (totalMs / 1000)).toFixed(2))
        : null;
      const prefillToksPerSec = (m.promptTokens && ttftMs > 0)
        ? parseFloat((m.promptTokens / (ttftMs / 1000)).toFixed(1))
        : null;

      result = {
        runId, testName: test.name,
        promptTokens: m.promptTokens ?? null, completionTokens: m.completionTokens ?? null,
        ttftMs, totalMs, tokensPerSecond, prefillToksPerSec,
        success: true, error: null, outputPreview: m.text.slice(0, 200)
      };
    } catch (err) {
      result = {
        runId, testName: test.name,
        promptTokens: null, completionTokens: null,
        ttftMs: null, totalMs: null, tokensPerSecond: null, prefillToksPerSec: null,
        success: false, error: err.message, outputPreview: null
      };
    }

    results.push({ ...result, tasks: test.tasks });
    onProgress?.({ type: 'result', test: test.name, label: test.label, result });
  }

  const warnings    = await _buildWarnings(results, resolvedModel, provider, detectedReasoning);
  const suitability = _computeSuitability(results);
  onProgress?.({ type: 'done', runId, suitability, warnings, isReasoning: detectedReasoning });

  return { runId, provider: effectiveType, model: resolvedModel, results, suitability, warnings, isReasoning: detectedReasoning };
}

async function _buildWarnings(results, model, provider, detectedReasoning) {
  const warnings = [];

  if (detectedReasoning) {
    let suggestedModels = null;
    if (typeof provider.listModels === 'function') {
      const available = await provider.listModels().catch(() => null);
      if (available?.length) {
        const alternatives = available.filter(m => !isReasoningModel(m));
        if (alternatives.length) suggestedModels = alternatives;
      }
    }
    warnings.push({
      type: 'reasoning_model',
      message:
        'This is a reasoning model — it generates a think block before answering. ' +
        'That causes very high TTFT. Switch to a plain instruct model for better performance.',
      suggestedModels: suggestedModels ?? FALLBACK_INSTRUCT_SUGGESTIONS
    });
    return warnings;
  }

  // Cold-start: first-test TTFT is >5 s and >3× the second test's TTFT.
  const shortResult  = results.find(r => r.testName === 'short');
  const mediumResult = results.find(r => r.testName === 'medium');
  if (
    shortResult?.ttftMs  > 5000 &&
    mediumResult?.ttftMs != null &&
    shortResult.ttftMs   > 3 * mediumResult.ttftMs
  ) {
    warnings.push({
      type: 'cold_start',
      message:
        `First-test TTFT was ${(shortResult.ttftMs / 1000).toFixed(1)}s — the model was loading into VRAM. ` +
        `Subsequent tests settled at ${(mediumResult.ttftMs / 1000).toFixed(1)}s. ` +
        `Throughput numbers are still valid.`,
      shortTtftMs:  shortResult.ttftMs,
      mediumTtftMs: mediumResult.ttftMs
    });
  }

  return warnings;
}

function _computeSuitability(results) {
  const out = {};
  for (const [task, thresh] of Object.entries(THRESHOLDS)) {
    const relevant = TESTS
      .filter(t => t.tasks.includes(task))
      .map(t => results.find(r => r.testName === t.name))
      .filter(r => r?.success);

    if (relevant.length === 0) { out[task] = { ok: null, reason: 'No successful tests' }; continue; }

    const slow = relevant.find(r => r.tokensPerSecond !== null && r.tokensPerSecond < thresh.minToksPerSec);
    out[task] = slow
      ? { ok: false, reason: `${slow.tokensPerSecond.toFixed(1)} tok/s below ${thresh.minToksPerSec} on "${slow.testName}"` }
      : { ok: true };
  }

  const stress = results.find(r => r.testName === 'stress' && r.success);
  if (stress?.prefillToksPerSec != null) out._prefill = { toksPerSec: stress.prefillToksPerSec };

  return out;
}
