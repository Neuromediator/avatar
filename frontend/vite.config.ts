/**
 * Vite config for the Avatar frontend.
 *
 * - Multi-page build: index.html (visitor, served at "/") and admin.html
 *   (admin, served at "/admin") -> dist/index.html and dist/admin.html.
 * - Dev server proxies the FastAPI backend (default http://localhost:8000,
 *   override with AVATAR_BACKEND_URL): "/api/*" plus "/admin", "/admin/" and
 *   "/admin/*" (login, logout, admin API). "/admin.html" is NOT proxied, so the
 *   admin screen also gets hot reload at http://localhost:5173/admin.html.
 *
 * Note: this file is intentionally outside the `tsc --noEmit` program (it runs
 * in Node and the project ships no @types/node); Vite transpiles it itself.
 */
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const backend = process.env.AVATAR_BACKEND_URL || 'http://localhost:8000';

/**
 * `import sprite from 'virtual:icon-sprite'` -> the text of public/icons.svg.
 * public/icons.svg stays the single source of truth (served at /icons.svg for
 * external `<use href="/icons.svg#i-...">`) while the app inlines it into the
 * DOM at startup (Vite forbids importing files from public/ directly).
 */
function iconSprite(): Plugin {
  const VIRTUAL_ID = 'virtual:icon-sprite';
  const RESOLVED_ID = '\0' + VIRTUAL_ID;
  const file = fileURLToPath(new URL('./public/icons.svg', import.meta.url));
  return {
    name: 'avatar-icon-sprite',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      this.addWatchFile(file);
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
    },
    handleHotUpdate(ctx) {
      if (ctx.file !== file) return;
      const mod = ctx.server.moduleGraph.getModuleById(RESOLVED_ID);
      if (mod) ctx.server.moduleGraph.invalidateModule(mod);
      ctx.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}

const proxy = {
  '/api': { target: backend, changeOrigin: true },
  '^/admin(/.*)?$': { target: backend, changeOrigin: true },
};

export default defineConfig({
  base: '/',
  plugins: [iconSprite()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
  server: { proxy },
  preview: { proxy },
});
