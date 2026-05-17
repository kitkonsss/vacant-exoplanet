import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const dev = process.env.NODE_ENV === 'development';

/** @type {import('@sveltejs/kit').Config} */
const config = {
    preprocess: vitePreprocess(),
    kit: {
        adapter: adapter({
            pages: 'build',
            assets: 'build',
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
