import { describe, expect, it } from 'vitest';
import { waitForJob, type WaitableJob } from './jobs';

describe('waitForJob', () => {
  it('returns as soon as the job finishes', async () => {
    let calls = 0;
    let now = 0;
    const result = await waitForJob('j1', 30, {
      now: () => now,
      sleep: async ms => { now += ms; },
      getJob: async (): Promise<WaitableJob> => {
        calls += 1;
        return calls < 3
          ? { id: 'j1', status: 'running', steps: ['started'] }
          : { id: 'j1', status: 'success', steps: ['started', 'done'], message: 'ok' };
      },
    });
    expect(result.timedOut).toBe(false);
    expect(result.job?.status).toBe('success');
    expect(result.job?.steps).toEqual(['started', 'done']);
    expect(calls).toBe(3);
  });

  it('returns the last state when the timeout passes', async () => {
    let now = 0;
    const result = await waitForJob('j2', 2, {
      now: () => now,
      sleep: async ms => { now += ms; },
      getJob: async (): Promise<WaitableJob> => ({ id: 'j2', status: 'running', steps: ['still working'] }),
    });
    expect(result.timedOut).toBe(true);
    expect(result.job?.status).toBe('running');
    expect(result.job?.steps).toEqual(['still working']);
    expect(now).toBe(2000);
  });

  it('answers at once for a finished job or a missing one', async () => {
    const finished = await waitForJob('j3', 30, {
      sleep: async () => undefined,
      getJob: async (): Promise<WaitableJob> => ({ id: 'j3', status: 'failed', message: 'nope' }),
    });
    expect(finished).toMatchObject({ timedOut: false, job: { status: 'failed', message: 'nope' } });

    const missing = await waitForJob('j4', 30, { sleep: async () => undefined, getJob: async () => null });
    expect(missing).toEqual({ job: null, timedOut: false });
  });
});
