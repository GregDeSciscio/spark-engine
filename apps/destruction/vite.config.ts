import { defineConfig } from 'vite';

export default defineConfig({
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
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
