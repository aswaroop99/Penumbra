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
/** data/ subfolders the built site needs (COSMOS 3D grids for the 3D map tab). */
const DATA_SUBDIRS = ['cosmos'];

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
      // Top-level layer files plus the subfolders the pages load (prototype outputs stay out).
      for (const sub of ['', ...DATA_SUBDIRS]) {
        const dir = join(DATA_DIR, sub);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          if (!MIME[extname(name)] || !statSync(join(dir, name)).isFile()) continue;
          this.emitFile({
            type: 'asset',
            fileName: sub ? `data/${sub}/${name}` : `data/${name}`,
            source: readFileSync(join(dir, name)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [penumbraData()],
  // The Python venv and data dirs contain .html/.json files; don't reload the page when they change.
  server: { port: 5173, watch: { ignored: ['**/venv/**', '**/.venv*/**', '**/myenv/**', '**/data/**', '**/des_map/reader_runs/**', '**/inference/work/**'] } },
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
