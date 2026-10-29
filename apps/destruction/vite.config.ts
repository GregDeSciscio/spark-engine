import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  // `vite build --mode portfolio` (pnpm build:portfolio) is the copy hosted on Greg's portfolio at
  // /games/spark-destruction/: every URL is under that base (src/sounds.ts builds the sound URLs
  // from import.meta.env.BASE_URL; the strain worker is a sibling chunk), and no source maps ship.
  const portfolio = mode === 'portfolio';
  return {
    base: portfolio ? '/games/spark-destruction/' : '/',
    resolve: {
      // Every "three" import resolves to the WebGPU build, the same rule as the other apps.
      alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
    },
    server: {
      // The preview tooling assigns a port through PORT; fall back to the app's own.
      port: Number(process.env.PORT) || 5186,
      strictPort: false,
    },
    // The engine's strain worker (ADR-011) is an ES module worker.
    worker: { format: 'es' },
    build: {
      target: 'esnext',
      sourcemap: !portfolio,
      chunkSizeWarningLimit: 4096,
    },
  };
});
