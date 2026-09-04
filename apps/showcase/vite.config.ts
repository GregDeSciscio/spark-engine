import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // Same rule as the benchmark: every "three" import resolves to the WebGPU build.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: {
    port: 5174,
    strictPort: false,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
