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
            // Project Pages at https://kitkonsss.github.io/vacant-exoplanet/
            base: dev ? '' : '/vacant-exoplanet'
        },
        alias: {
            $lib: './src/lib'
        }
    }
};

export default config;
