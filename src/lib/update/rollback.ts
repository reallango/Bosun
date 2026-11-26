/**
 * Choosing the commit a rollback goes to, and refusing when that is not possible.
 *
 * A rollout records the commit the cluster ran before it (`from`). Rolling back takes the previous commit of the last
 * finished rollout (a successful update or a stopped one) and moves every node to that commit's published image
 * (`sha-<7>`) exactly like an update. These decisions are pure so the API and the tests share them.
 */
import { UpdateError } from './errors';
import { commitTag } from './version';

export type RolloutKind = 'update' | 'rollback';

/** The parts of a rollout record a rollback decision reads (older records may lack `kind` and `from`). */
export interface RolloutRecord {
  target: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at?: string | null;
  kind?: RolloutKind;
  from?: string | null;
}

export interface ImageRevision { commit: string | null }

const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/** A commit we can name; "unknown" and anything else is no commit. */
export function usableCommit(commit: string | null | undefined): string | null {
  const v = typeof commit === 'string' ? commit.trim().toLowerCase() : '';
  return COMMIT_RE.test(v) ? v : null;
}

/** Whether two commits name the same build (either may be short). */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = usableCommit(a);
  const y = usableCommit(b);
  return !!x && !!y && (x.startsWith(y.slice(0, 7)) || y.startsWith(x.slice(0, 7)));
}

/** A rollout is in progress: running and started less than an hour ago, so a stale record does not block. */
export function rolloutRunning(r: RolloutRecord | null | undefined, now = Date.now()): boolean {
  return !!r && r.status === 'running' && now - Date.parse(r.started_at) < 60 * 60_000;
}

/**
 * The commit the cluster ran before the last finished rollout, or null when there is none: the record is still
 * running, has no origin (older records), or names the version it moved to. A stale running record (a rollout that
 * died) counts as finished, so it can still be undone.
 */
export function previousCommit(r: RolloutRecord | null | undefined, now = Date.now()): string | null {
  if (!r) return null;
  const finished = r.status === 'running' ? !rolloutRunning(r, now) : !!r.finished_at;
  if (!finished) return null;
  const from = usableCommit(r.from);
  return from && !sameCommit(from, r.target) ? from : null;
}

/** The commit and image a rollback goes to. Throws UpdateError when it cannot start. */
export function rollbackTarget(r: RolloutRecord | null | undefined, image: string, now = Date.now()): { target: string; image: string } {
  if (rolloutRunning(r, now)) throw new UpdateError('An update is already running', 409, 'UPDATE_RUNNING');
  const target = previousCommit(r, now);
  if (!target) throw new UpdateError('There is no previous version to roll back to', 409, 'NO_PREVIOUS');
  return { target, image: `${image}:${commitTag(target)}` };
}

/** Why the registry cannot supply the image a rollback needs, or null when it can. */
export function rollbackImageProblem(rev: ImageRevision | null | undefined, target: string, image: string): string | null {
  if (!rev?.commit) return `The registry has no image for ${target.slice(0, 7)} (${image}); it may have been removed`;
  if (!sameCommit(rev.commit, target)) return `The registry's image for ${image} was built from ${rev.commit.slice(0, 7)}, not ${target.slice(0, 7)}`;
  return null;
}
