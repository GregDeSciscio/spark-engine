import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engine's own suite, plus the game logic an app can test without a
    // renderer (the showcase's mission and alert models).
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
  },
});
