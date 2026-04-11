import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Set to true to stop the dev server reloading when files in data/media/ change.
const DISABLE_MEDIA_WATCH = true;
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const githubPagesBase = process.env.GITHUB_ACTIONS === 'true' && repoName
  ? `/${repoName}/`
  : '/';

const VIRTUAL_ID = 'virtual:media-manifest';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

/**
 * Scans data/media/ at build/dev-start time and exposes a virtual module:
 *
 *   import manifest from 'virtual:media-manifest';
 *   // manifest: Record<string, string[]>  { "punakaki-blowholes": ["foo.webp", "bar.mp4"] }
 *
 * In dev mode the virtual module is invalidated whenever files inside
 * data/media/ are added or removed, triggering an HMR full-reload.
 */
function mediaManifestPlugin(): Plugin {
  const mediaDir = path.resolve(__dirname, 'data/media');

  function buildManifest(): string {
    const result: Record<string, string[]> = {};
    if (!fs.existsSync(mediaDir)) return `export default ${JSON.stringify(result)}`;
    for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = fs.readdirSync(path.join(mediaDir, entry.name))
        .filter(f => /\.(webp|jpg|jpeg|png|gif|mp4|mov|webm)$/i.test(f));
      if (files.length > 0) result[entry.name] = files;
    }
    return `export default ${JSON.stringify(result)}`;
  }

  return {
    name: 'media-manifest',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },
    load(id) {
      if (id === RESOLVED_ID) return buildManifest();
    },
    configureServer(server) {
      if (DISABLE_MEDIA_WATCH) return;
      // Watch data/media for new/removed files and invalidate the virtual module
      server.watcher.add(mediaDir);
      server.watcher.on('all', (event, filePath) => {
        if (!filePath.startsWith(mediaDir)) return;
        if (!['add', 'unlink', 'addDir', 'unlinkDir'].includes(event)) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      });
    },
  };
}

export default defineConfig({
  base: githubPagesBase,
  publicDir: 'data',
  plugins: [mediaManifestPlugin()],
});
