import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // three's addons import from bare "three". Point that at the WebGPU build so
    // the engine, the addons, and the app share one set of three classes.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
