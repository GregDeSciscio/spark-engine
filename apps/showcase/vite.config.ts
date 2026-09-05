import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // Same rule as the benchmark: every "three" import resolves to the WebGPU build.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: {
    // The preview tooling assigns a port through PORT; fall back to the app's own.
    port: Number(process.env.PORT) || 5174,
    strictPort: false,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
