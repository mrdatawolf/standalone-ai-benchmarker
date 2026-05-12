import { getDb } from './db.js';

export function saveRun({ runId, timestamp, deviceId, deviceName, hardware, provider, model, suitability, warnings, isReasoning, results }) {
  const db = getDb();

  const insertRun = db.prepare(`
    INSERT INTO runs (run_id, timestamp, device_id, device_name, hardware, provider, model, suitability, warnings, is_reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertResult = db.prepare(`
    INSERT INTO test_results
      (run_id, test_name, prompt_tokens, completion_tokens, ttft_ms, total_ms,
       tokens_per_second, prefill_toks_per_second, success, error, output_preview)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    insertRun.run(
      runId, timestamp, deviceId, deviceName ?? null,
      JSON.stringify(hardware), provider, model,
      JSON.stringify(suitability), JSON.stringify(warnings),
      isReasoning ? 1 : 0
    );
    for (const r of results) {
      insertResult.run(
        runId, r.testName,
        r.promptTokens ?? null, r.completionTokens ?? null,
        r.ttftMs ?? null, r.totalMs ?? null,
        r.tokensPerSecond ?? null, r.prefillToksPerSec ?? null,
        r.success ? 1 : 0, r.error ?? null, r.outputPreview ?? null
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function _hydrate(run) {
  run.hardware    = JSON.parse(run.hardware);
  run.suitability = run.suitability ? JSON.parse(run.suitability) : null;
  run.warnings    = run.warnings    ? JSON.parse(run.warnings)    : [];
  run.results     = getDb().prepare('SELECT * FROM test_results WHERE run_id = ? ORDER BY id').all(run.run_id);
  return run;
}

export function getRuns(limit = 20) {
  return getDb()
    .prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map(_hydrate);
}

export function getRunById(runId) {
  const run = getDb().prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
  return run ? _hydrate(run) : null;
}

export function markSynced(runId) {
  getDb().prepare('UPDATE runs SET synced = 1 WHERE run_id = ?').run(runId);
}

export function getUnsyncedRuns() {
  return getDb()
    .prepare('SELECT * FROM runs WHERE synced = 0 ORDER BY created_at ASC')
    .all()
    .map(_hydrate);
}
