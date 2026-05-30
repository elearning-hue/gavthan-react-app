import { defineConfig } from 'vite';

// Plain Vite (no React plugin needed): the app uses React.createElement directly,
// not JSX, so there's no JSX transform to configure. This keeps the build minimal
// and avoids touching the original component code.
//
// base: GitHub Pages serves a project repo under /<repo>/, so when building for the
// gh-pages deploy we set base to the repo subpath. Vercel (and local) serve from /,
// so base stays '/'. The `deploy` script sets DEPLOY_TARGET=gh-pages.
const isGhPages = process.env.DEPLOY_TARGET === 'gh-pages';

export default defineConfig({
  base: isGhPages ? '/gavthan-react-app/' : '/',
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2018',
    chunkSizeWarningLimit: 1500,
    // Deterministic output layout: every build emits the SAME folder/file
    // structure (only the content hashes change when code changes, which is
    // required for cache-busting). All JS under assets/js, css under assets/css,
    // other assets under assets/. Hashes keep deploys cacheable; the *set* of
    // files and their folders stays identical push to push.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/js/[name]-[hash].js',
        chunkFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: function (info) {
          var name = (info.name || '');
          if (name.endsWith('.css')) return 'assets/css/[name]-[hash][extname]';
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
