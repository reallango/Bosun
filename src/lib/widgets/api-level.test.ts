import { describe, it, expect } from 'vitest';
import { WIDGET_API_LEVEL, apiLevelProblem } from './api-level';

describe('WIDGET_API_LEVEL', () => {
  it('is 11', () => {
    expect(WIDGET_API_LEVEL).toBe(11);
  });
});

describe('apiLevelProblem', () => {
  it('accepts a package that needs no level, or one this Bosun has', () => {
    expect(apiLevelProblem(undefined)).toBeNull();
    expect(apiLevelProblem(null)).toBeNull();
    expect(apiLevelProblem({ api: 1 })).toBeNull();
    expect(apiLevelProblem({ api: WIDGET_API_LEVEL })).toBeNull();
  });

  it('refuses a newer level with the message the admin is shown', () => {
    expect(apiLevelProblem({ api: WIDGET_API_LEVEL + 1 })).toBe(
      'This widget needs a newer Bosun (widget API level 12; this Bosun has 11). Update Bosun first.',
    );
    expect(apiLevelProblem({ api: 99 })).toBe(
      'This widget needs a newer Bosun (widget API level 99; this Bosun has 11). Update Bosun first.',
    );
  });
});
