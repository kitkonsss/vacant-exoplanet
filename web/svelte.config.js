import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const lifecycle = process.env.npm_lifecycle_event || '';
const dev = lifecycle === 'dev' || process.env.NODE_ENV === 'development';
const outDir = dev ? '.svelte-kit-dev' : '.svelte-kit-build';

/** @type {import('@sveltejs/kit').Config} */
const config = {
    preprocess: vitePreprocess(),
    kit: {
        outDir,
        adapter: adapter({
            pages: 'dist',
            assets: 'dist',
            fallback: '404.html',
            strict: true
        }),
        paths: {
            // base '' for Cloudflare Pages (served at the domain root, where the
            // same-origin /api/price function lives). The legacy GitHub Pages
            // deploy sets PAGES_BASE=/vacant-exoplanet so the old project-page URL
            // keeps working unchanged during the migration.
            base: dev ? '' : (process.env.PAGES_BASE ?? '')
        },
        alias: {
            $lib: './src/lib'
        }
    }
};

export default config;
