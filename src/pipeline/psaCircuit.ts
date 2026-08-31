import type { DatabaseSync } from 'node:sqlite';

/**
 * A single cross-phase, cross-tick circuit-breaker for psacard.com.
 *
 * `runQueue`'s `haltOnRateLimit` + `cooldown` only guard one queue run. PSA
 * hard-429s for the rest of the day once tripped (see the supervisor loop-quirk
 * memo), and the cert / identity / fetch phases each used to discover that on
 * their own and pause on their own -- so the phase that runs first could burn
 * the day's allowance before the others got a turn.
 *
 * This breaker is shared by every PSA phase: the first 429 anywhere parks all
 * PSA work, with an escalating back-off, recorded as one `pipeline_pauses` row.
 * The in-memory state is rehydrated from that row so a daemon restart respects a
 * still-active daily block.
 */

interface CircuitState {
  /** epoch ms; 0 means "not blocked and not yet rehydrated from the DB". */
  blockedUntil: number;
  reason: string;
  strikes: number;
}

let state: CircuitState = { blockedUntil: 0, reason: '', strikes: 0 };
let rehydrated = false;

/** strike 1 -> 30 min, strike 2 -> 60 min, strike 3+ -> until the next UTC day. */
const STRIKE_BACKOFF_MS = [30 * 60_000, 60 * 60_000];

function nextUtcMidnight(fromMs: number): number {
  const d = new Date(fromMs);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

export interface PsaCircuit {
  open: boolean;
  /** ISO time the breaker reopens, or null when it is closed. */
  until: string | null;
  reason: string;
}

/** Reset in-process state -- tests only. */
export function __resetPsaCircuit(): void {
  state = { blockedUntil: 0, reason: '', strikes: 0 };
  rehydrated = false;
}

export function psaCircuitOpen(db: DatabaseSync, pipelineRunId: string): PsaCircuit {
  if (!rehydrated) {
    rehydrated = true;
    const row = db.prepare(
      `SELECT reason, resume_after FROM pipeline_pauses
       WHERE pipeline_run_id=? AND stage_name='psa' AND source='psa' AND resolved_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    ).get(pipelineRunId) as { reason: string; resume_after: string | null } | undefined;
    if (row?.resume_after) {
      state = { blockedUntil: Date.parse(row.resume_after), reason: row.reason, strikes: 1 };
    }
  }
  if (state.blockedUntil > Date.now()) {
    return { open: true, until: new Date(state.blockedUntil).toISOString(), reason: state.reason };
  }
  return { open: false, until: null, reason: '' };
}

/** Record a 429 from any PSA phase and open (or extend) the breaker. */
export function tripPsaCircuit(db: DatabaseSync, pipelineRunId: string, detail: string): PsaCircuit {
  state.strikes += 1;
  const now = Date.now();
  const until = state.strikes <= STRIKE_BACKOFF_MS.length
    ? now + STRIKE_BACKOFF_MS[state.strikes - 1]!
    : nextUtcMidnight(now);
  const resumeAfter = new Date(until).toISOString();
  state.blockedUntil = until;
  state.reason = `PSA rate-limited (${detail}); backing off until ${resumeAfter}`;

  const open = db.prepare(
    `SELECT pipeline_pause_id FROM pipeline_pauses
     WHERE pipeline_run_id=? AND stage_name='psa' AND source='psa' AND resolved_at IS NULL`,
  ).get(pipelineRunId) as { pipeline_pause_id: number } | undefined;
  if (open) {
    db.prepare(`UPDATE pipeline_pauses SET reason=?, resume_after=? WHERE pipeline_pause_id=?`)
      .run(state.reason, resumeAfter, open.pipeline_pause_id);
  } else {
    db.prepare(
      `INSERT INTO pipeline_pauses (pipeline_run_id,stage_name,source,reason,resume_after,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(pipelineRunId, 'psa', 'psa', state.reason, resumeAfter, new Date().toISOString());
  }
  return { open: true, until: resumeAfter, reason: state.reason };
}

/** A clean PSA tick: decay one strike and, once fully clear, resolve the pause. */
export function notePsaSuccess(db: DatabaseSync, pipelineRunId: string): void {
  if (state.strikes === 0 && state.blockedUntil === 0) return;
  state = { blockedUntil: 0, reason: '', strikes: Math.max(0, state.strikes - 1) };
  db.prepare(
    `UPDATE pipeline_pauses SET resolved_at=? WHERE pipeline_run_id=? AND stage_name='psa'
       AND source='psa' AND resolved_at IS NULL`,
  ).run(new Date().toISOString(), pipelineRunId);
}
