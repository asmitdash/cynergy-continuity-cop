/**
 * Persistent job store on Neon Postgres. Vercel Hobby has a 60s cap on
 * function calls, so long-running document ingestion can't complete in a
 * single request. Instead:
 *
 *  1. /api/job/start parses the PDF and writes a job row + N batch rows.
 *  2. The client polls /api/job/[id]/tick every ~2s.
 *  3. Each tick picks one queued step (a batch to ingest, or a sweep, or the
 *     final normalize) and runs it — well under 60s per tick.
 *  4. Progress lives in Postgres; SSE not needed, plain JSON polling works.
 *
 * Two tables:
 *   continuity_jobs      — one row per upload
 *   continuity_batches   — one row per chapter batch, tracks ingest state
 *   continuity_flags     — final contradictions found by the sweep
 */

import { Pool, type QueryResult, type QueryResultRow } from "pg";

const CONN =
  process.env.POSTGRES_URL ??
  process.env.DATABASE_URL ??
  process.env.POSTGRES_PRISMA_URL;

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function getPool(): Pool {
  if (!pool) {
    if (!CONN) throw new Error("no Postgres connection string configured");
    pool = new Pool({
      connectionString: CONN,
      max: 3,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const p = getPool();
      await p.query(`
        CREATE TABLE IF NOT EXISTS continuity_jobs (
          id             TEXT PRIMARY KEY,
          filename       TEXT NOT NULL,
          total_pages    INTEGER,
          total_words    INTEGER,
          total_chapters INTEGER,
          strategy       TEXT,
          state          TEXT NOT NULL DEFAULT 'queued',
                         -- queued | ingesting | sweeping | normalizing | done | error
          error          TEXT,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS continuity_batches (
          job_id     TEXT NOT NULL REFERENCES continuity_jobs(id) ON DELETE CASCADE,
          idx        INTEGER NOT NULL,
          title      TEXT NOT NULL,
          content    TEXT NOT NULL,
          word_count INTEGER NOT NULL,
          state      TEXT NOT NULL DEFAULT 'queued',
                     -- queued | ingesting | ingested | error
          error      TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (job_id, idx)
        );
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS continuity_sweeps (
          job_id      TEXT NOT NULL REFERENCES continuity_jobs(id) ON DELETE CASCADE,
          kind        TEXT NOT NULL, -- graph-cot | triplet
          state       TEXT NOT NULL DEFAULT 'queued',
          raw_text    TEXT,
          error       TEXT,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (job_id, kind)
        );
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS continuity_flags (
          job_id            TEXT NOT NULL REFERENCES continuity_jobs(id) ON DELETE CASCADE,
          idx               INTEGER NOT NULL,
          new_scene_span    TEXT NOT NULL,
          contradicts_fact  TEXT NOT NULL,
          contradiction_kind TEXT NOT NULL,
          explanation       TEXT NOT NULL,
          confidence        FLOAT NOT NULL,
          PRIMARY KEY (job_id, idx)
        );
      `);
      await p.query(
        `CREATE INDEX IF NOT EXISTS continuity_batches_state_idx ON continuity_batches (job_id, state);`,
      );
    })();
  }
  return schemaReady;
}

async function q<T extends QueryResultRow>(
  sql: string,
  args: unknown[] = [],
): Promise<QueryResult<T>> {
  await ensureSchema();
  return getPool().query<T>(sql, args);
}

// ---------- Jobs ----------

export interface JobRow {
  id: string;
  filename: string;
  total_pages: number | null;
  total_words: number | null;
  total_chapters: number | null;
  strategy: string | null;
  state: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export async function createJob(input: {
  id: string;
  filename: string;
  totalPages: number;
  totalWords: number;
  totalChapters: number;
  strategy: string;
}): Promise<void> {
  await q(
    `INSERT INTO continuity_jobs (id, filename, total_pages, total_words, total_chapters, strategy, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'ingesting')`,
    [
      input.id,
      input.filename,
      input.totalPages,
      input.totalWords,
      input.totalChapters,
      input.strategy,
    ],
  );
}

export async function getJob(id: string): Promise<JobRow | null> {
  const r = await q<JobRow>(`SELECT * FROM continuity_jobs WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function setJobState(id: string, state: string, error?: string): Promise<void> {
  await q(
    `UPDATE continuity_jobs SET state = $2, error = $3, updated_at = NOW() WHERE id = $1`,
    [id, state, error ?? null],
  );
}

// ---------- Batches ----------

export interface BatchRow {
  job_id: string;
  idx: number;
  title: string;
  content: string;
  word_count: number;
  state: string;
  error: string | null;
}

export async function insertBatches(
  jobId: string,
  batches: Array<{ title: string; content: string; wordCount: number }>,
): Promise<void> {
  if (batches.length === 0) return;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  batches.forEach((b, i) => {
    const off = i * 4;
    placeholders.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4})`);
    values.push(jobId, i, b.title, b.content);
  });
  // Split into an actual multi-value insert; word_count computed here.
  const p = getPool();
  await ensureSchema();
  // Use separate inserts to keep SQL simple — batches are typically <50.
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    await p.query(
      `INSERT INTO continuity_batches (job_id, idx, title, content, word_count, state)
       VALUES ($1, $2, $3, $4, $5, 'queued')`,
      [jobId, i, b.title, b.content, b.wordCount],
    );
  }
  // Suppress unused warning
  void values;
  void placeholders;
}

export async function getBatchStates(
  jobId: string,
): Promise<Array<{ idx: number; title: string; state: string; error: string | null }>> {
  const r = await q<{ idx: number; title: string; state: string; error: string | null }>(
    `SELECT idx, title, state, error FROM continuity_batches WHERE job_id = $1 ORDER BY idx ASC`,
    [jobId],
  );
  return r.rows;
}

export async function claimNextQueuedBatch(jobId: string): Promise<BatchRow | null> {
  // Atomically claim one queued batch by flipping it to "ingesting".
  const r = await q<BatchRow>(
    `UPDATE continuity_batches
        SET state = 'ingesting', updated_at = NOW()
      WHERE (job_id, idx) = (
        SELECT job_id, idx FROM continuity_batches
        WHERE job_id = $1 AND state = 'queued'
        ORDER BY idx ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

export async function markBatchDone(jobId: string, idx: number): Promise<void> {
  await q(
    `UPDATE continuity_batches SET state = 'ingested', updated_at = NOW() WHERE job_id = $1 AND idx = $2`,
    [jobId, idx],
  );
}

export async function markBatchError(jobId: string, idx: number, error: string): Promise<void> {
  await q(
    `UPDATE continuity_batches SET state = 'error', error = $3, updated_at = NOW() WHERE job_id = $1 AND idx = $2`,
    [jobId, idx, error],
  );
}

export async function countBatches(
  jobId: string,
): Promise<{ total: number; ingested: number; error: number }> {
  const r = await q<{ state: string; c: string }>(
    `SELECT state, COUNT(*)::text AS c FROM continuity_batches WHERE job_id = $1 GROUP BY state`,
    [jobId],
  );
  let total = 0;
  let ingested = 0;
  let err = 0;
  for (const row of r.rows) {
    const n = Number(row.c);
    total += n;
    if (row.state === "ingested") ingested = n;
    if (row.state === "error") err = n;
  }
  return { total, ingested, error: err };
}

// ---------- Sweeps ----------

export async function insertSweeps(jobId: string, kinds: string[]): Promise<void> {
  const p = getPool();
  await ensureSchema();
  for (const k of kinds) {
    await p.query(
      `INSERT INTO continuity_sweeps (job_id, kind, state) VALUES ($1, $2, 'queued')
       ON CONFLICT (job_id, kind) DO NOTHING`,
      [jobId, k],
    );
  }
}

export async function claimNextQueuedSweep(
  jobId: string,
): Promise<{ kind: string } | null> {
  const r = await q<{ kind: string }>(
    `UPDATE continuity_sweeps
        SET state = 'running', updated_at = NOW()
      WHERE (job_id, kind) = (
        SELECT job_id, kind FROM continuity_sweeps
        WHERE job_id = $1 AND state = 'queued'
        ORDER BY kind ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING kind`,
    [jobId],
  );
  return r.rows[0] ?? null;
}

export async function saveSweep(
  jobId: string,
  kind: string,
  text: string,
): Promise<void> {
  await q(
    `UPDATE continuity_sweeps SET raw_text = $3, state = 'done', updated_at = NOW() WHERE job_id = $1 AND kind = $2`,
    [jobId, kind, text],
  );
}

export async function markSweepError(
  jobId: string,
  kind: string,
  err: string,
): Promise<void> {
  await q(
    `UPDATE continuity_sweeps SET state = 'error', error = $3, updated_at = NOW() WHERE job_id = $1 AND kind = $2`,
    [jobId, kind, err],
  );
}

export async function getSweepStates(
  jobId: string,
): Promise<Array<{ kind: string; state: string; raw_text: string | null }>> {
  const r = await q<{ kind: string; state: string; raw_text: string | null }>(
    `SELECT kind, state, raw_text FROM continuity_sweeps WHERE job_id = $1 ORDER BY kind ASC`,
    [jobId],
  );
  return r.rows;
}

// ---------- Flags ----------

export interface FlagInput {
  new_scene_span: string;
  contradicts_fact: string;
  contradiction_kind: string;
  explanation: string;
  confidence: number;
}

export async function saveFlags(jobId: string, flags: FlagInput[]): Promise<void> {
  const p = getPool();
  await ensureSchema();
  await p.query(`DELETE FROM continuity_flags WHERE job_id = $1`, [jobId]);
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    await p.query(
      `INSERT INTO continuity_flags (job_id, idx, new_scene_span, contradicts_fact, contradiction_kind, explanation, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [jobId, i, f.new_scene_span, f.contradicts_fact, f.contradiction_kind, f.explanation, f.confidence],
    );
  }
}

export async function getFlags(jobId: string): Promise<FlagInput[]> {
  const r = await q<FlagInput>(
    `SELECT new_scene_span, contradicts_fact, contradiction_kind, explanation, confidence
       FROM continuity_flags
      WHERE job_id = $1
      ORDER BY idx ASC`,
    [jobId],
  );
  return r.rows;
}
