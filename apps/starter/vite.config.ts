import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // Every "three" import resolves to the WebGPU build, the same rule as the other apps.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: {
    port: Number(process.env.PORT) || 5175,
    strictPort: false,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
