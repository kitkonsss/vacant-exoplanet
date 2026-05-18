import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = process.cwd();
const targetsToClean = [
    path.join(projectRoot, '.svelte-kit-build', 'output'),
    path.join(projectRoot, '.svelte-kit-build', 'generated', 'client-optimized')
];

function makeWritable(targetPath) {
    try {
        fs.chmodSync(targetPath, 0o666);
    } catch {
        // Ignore chmod failures and let the next delete attempt decide.
    }
}

function forceRemove(targetPath) {
    if (!fs.existsSync(targetPath)) return;

    if (process.platform === 'win32') {
        const windowsTarget = path.win32.normalize(path.resolve(targetPath));
        const cleanup = spawnSync(
            'cmd.exe',
            ['/d', '/s', '/c', `if exist "${windowsTarget}" (attrib -R "${windowsTarget}" /S /D && rmdir /S /Q "${windowsTarget}")`],
            {
                cwd: projectRoot,
                stdio: 'pipe',
                encoding: 'utf8'
            }
        );

        if (cleanup.status === 0 && !fs.existsSync(targetPath)) {
            return;
        }

        const cleanupOutput = [cleanup.stdout, cleanup.stderr].filter(Boolean).join('\n').trim();
        if (cleanupOutput) {
            console.error(cleanupOutput);
        }
    }

    try {
        fs.rmSync(targetPath, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 200
        });
        return;
    } catch {
        walkAndUnlock(targetPath);
        fs.rmSync(targetPath, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 200
        });
    }
}

function walkAndUnlock(targetPath) {
    makeWritable(targetPath);

    let entries = [];
    try {
        entries = fs.readdirSync(targetPath, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        const entryPath = path.join(targetPath, entry.name);
        if (entry.isDirectory()) {
            walkAndUnlock(entryPath);
            continue;
        }
        makeWritable(entryPath);
    }
}

for (const targetPath of targetsToClean) {
    forceRemove(targetPath);
}

const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');

const result = spawnSync(process.execPath, [viteCli, 'build'], {
    cwd: projectRoot,
    stdio: 'inherit'
});

if (result.error) {
    throw result.error;
}

process.exit(result.status ?? 1);
