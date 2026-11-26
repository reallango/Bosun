/**
 * Which Bosun this process is: the commit and branch its image was built from (BOSUN_COMMIT / BOSUN_CHANNEL, set by the image
 * workflow; a build on the host reports "unknown" / "local"). Public through /api/health so nodes can see each other's version.
 */
export interface BosunVersion { commit: string; short: string; channel: string }

const COMMIT_RE = /^[0-9a-f]{7,40}$/;

export function bosunVersion(): BosunVersion {
  const raw = String(process.env.BOSUN_COMMIT || '').trim().toLowerCase();
  const commit = COMMIT_RE.test(raw) ? raw : 'unknown';
  const channel = String(process.env.BOSUN_CHANNEL || 'local').replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 60) || 'local';
  return { commit, short: commit === 'unknown' ? 'unknown' : commit.slice(0, 7), channel };
}

/** The image tag the workflow gives a commit. */
export const commitTag = (commit: string) => `sha-${commit.slice(0, 7)}`;
