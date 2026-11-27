/** Long-poll for a widget job without keeping the caller's client busy. */

export interface WaitableJob {
  id: string;
  status: string;
  steps?: string[];
  percent?: number | null;
  message?: string | null;
}

export interface JobWaitDeps<T extends WaitableJob> {
  getJob(id: string): Promise<T | null>;
  sleep(ms: number): Promise<void>;
  now?(): number;
}


export interface JobWaitResult<T extends WaitableJob> {
  job: T | null;
  timedOut: boolean;
}

export const MAX_JOB_WAIT_SECONDS = 120;

/**
 * Poll `getJob` until it is no longer running, or until `timeoutSec` passes. Returns the last state either way.
 * The first check always happens, so a job that already finished answers at once.
 */
export async function waitForJob<T extends WaitableJob>(
  jobId: string, timeoutSec: number, deps: JobWaitDeps<T>, stepMs = 1000,
): Promise<JobWaitResult<T>> {
  const seconds = Math.min(Math.max(Math.floor(timeoutSec) || 0, 0), MAX_JOB_WAIT_SECONDS);
  const now = deps.now ?? Date.now;
  const started = now();
  for (;;) {
    const job = await deps.getJob(jobId);
    if (!job || job.status !== 'running') return { job, timedOut: false };
    if (now() - started + stepMs > seconds * 1000) return { job, timedOut: true };
    await deps.sleep(stepMs);
  }
}
