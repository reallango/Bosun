import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  // Next compiles JSX with the automatic runtime; tsconfig keeps `jsx: preserve` for it, so esbuild needs telling.
  esbuild: { jsx: 'automatic' },
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.{ts,js}'], environment: 'node' },
});
