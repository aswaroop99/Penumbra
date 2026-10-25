/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = resolve(ROOT, 'data');
// manifest.json lives next to the layer files it describes (moved there on the viewer branch).
// It is still served/emitted at `/manifest.json` as well, so the app's fetch URL is unchanged.
const MANIFEST = resolve(DATA_DIR, 'manifest.json');

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
};

/**
 * Serves the static data contract (`manifest.json` + `data/*.png|*.bin`) straight
 * from the repository root in dev/preview, and emits it into the build output.
 * Nothing is copied into the repo, and none of it goes into SpacetimeDB.
 */
function penumbraData(): Plugin {
  const serve = (url: string | undefined): { file: string; type: string } | null => {
    if (!url) return null;
    const path = decodeURIComponent(url.split('?')[0] ?? '');
    let file: string | null = null;
    if (path === '/manifest.json') {
      file = MANIFEST;
    } else if (path.startsWith('/data/')) {
      const candidate = normalize(join(ROOT, path));
      if (candidate.startsWith(DATA_DIR + sep)) file = candidate;
    }
    if (!file || !existsSync(file) || !statSync(file).isFile()) return null;
    const type = MIME[extname(file)];
    return type ? { file, type } : null;
  };

  const middleware = (
    req: { url?: string },
    res: {
      setHeader(k: string, v: string | number): void;
      end(): void;
    } & NodeJS.WritableStream,
    next: () => void
  ) => {
    const hit = serve(req.url);
    if (!hit) return next();
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Content-Length', statSync(hit.file).size);
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(hit.file).pipe(res);
  };

  return {
    name: 'penumbra-data',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    generateBundle() {
      if (existsSync(MANIFEST)) {
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.json',
          source: readFileSync(MANIFEST),
        });
      }
      if (existsSync(DATA_DIR)) {
        for (const name of readdirSync(DATA_DIR)) {
          if (!MIME[extname(name)]) continue;
          this.emitFile({
            type: 'asset',
            fileName: `data/${name}`,
            source: readFileSync(join(DATA_DIR, name)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [penumbraData()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      // Three pages: the cosmic-web app (index.html), the sky-layer viewer (layers.html) and the tour (guide.html).
      input: {
        main: resolve(ROOT, 'index.html'),
        layers: resolve(ROOT, 'layers.html'),
        guide: resolve(ROOT, 'guide.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
