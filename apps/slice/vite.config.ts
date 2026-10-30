import { createReadStream, existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** The destruction sandbox's sound takes (apps/destruction/public/sfx), shared rather than copied. */
const SFX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'destruction', 'public', 'sfx');

/** Serve them at /sfx in development, and copy them into the build. */
function sandboxSounds(): Plugin {
  return {
    name: 'slice-sandbox-sounds',
    configureServer(server) {
      server.middlewares.use('/sfx', (req, res, next) => {
        const file = path.join(SFX, decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
        if (!file.startsWith(SFX) || !existsSync(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
        createReadStream(file).pipe(res);
      });
    },
    async writeBundle(options) {
      if (options.dir) await cp(SFX, path.join(options.dir, 'sfx'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [sandboxSounds()],
  resolve: {
    // Every "three" import resolves to the WebGPU build, the same rule as the other apps.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: {
    port: Number(process.env.PORT) || 5187,
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
