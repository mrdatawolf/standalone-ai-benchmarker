import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../config.js';

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(join(DATA_DIR, 'data.db'));
  _db.exec('PRAGMA journal_mode = WAL');
  _initSchema(_db);
  return _db;
}

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      TEXT NOT NULL UNIQUE,
      timestamp   TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      device_name TEXT,
      hardware    TEXT NOT NULL,
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      suitability TEXT,
      warnings    TEXT,
      is_reasoning INTEGER DEFAULT 0,
      synced      INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS test_results (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                TEXT NOT NULL,
      test_name             TEXT NOT NULL,
      prompt_tokens         INTEGER,
      completion_tokens     INTEGER,
      ttft_ms               INTEGER,
      total_ms              INTEGER,
      tokens_per_second     REAL,
      prefill_toks_per_second REAL,
      success               INTEGER NOT NULL DEFAULT 1,
      error                 TEXT,
      output_preview        TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_runs_run_id  ON runs(run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_results_run  ON test_results(run_id);
  `);
}
