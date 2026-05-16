export const APP_NAME = 'Bosun';

export const AUTH = {
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: 7,
  BCRYPT_ROUNDS: 12,
  COOKIE_ACCESS: 'access_token',
  COOKIE_REFRESH: 'refresh_token',
} as const;

export const SSH = {
  DEFAULT_PORT: 22,
  DEFAULT_USER: 'svc-bosun',
  CONNECTION_TIMEOUT_MS: 10000,
  COMMAND_TIMEOUT_MS: 30000,
  POOL_MAX_PER_SERVER: 3,
  POOL_IDLE_TIMEOUT_MS: 300000,
  KEEPALIVE_INTERVAL_MS: 30000,
} as const;

export const HEALTH = {
  CHECK_INTERVAL_SEC: 30,
} as const;

export const WIDGET = {
  DEFAULT_REFRESH_SEC: 15,
  GRID_COLS: 12,
  GRID_ROW_HEIGHT: 80,
} as const;

export const RQLITE = {
  HTTP_PORT: process.env.RQLITE_HTTP_PORT || '4001',
  BASE_URL: `http://localhost:${process.env.RQLITE_HTTP_PORT || '4001'}`,
} as const;