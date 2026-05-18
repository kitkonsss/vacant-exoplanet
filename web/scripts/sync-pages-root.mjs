import fs from 'node:fs';
import path from 'node:path';

const webRoot = process.cwd();
const repoRoot = path.resolve(webRoot, '..');
const distRoot = path.join(webRoot, 'dist');

if (!fs.existsSync(distRoot)) {
    throw new Error(`Build output not found: ${distRoot}`);
}

function ensureDir(targetPath) {
    fs.mkdirSync(targetPath, { recursive: true });
}

function removePath(targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyFile(sourcePath, targetPath) {
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
}

function copyDir(sourceDir, targetDir) {
    ensureDir(targetDir);

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            copyDir(sourcePath, targetPath);
            continue;
        }

        copyFile(sourcePath, targetPath);
    }
}

for (const fileName of ['index.html', '404.html', 'favicon.svg']) {
    copyFile(path.join(distRoot, fileName), path.join(repoRoot, fileName));
}

removePath(path.join(repoRoot, '_app'));
copyDir(path.join(distRoot, '_app'), path.join(repoRoot, '_app'));

copyFile(
    path.join(distRoot, 'web', 'dist', 'index.html'),
    path.join(repoRoot, 'web', 'dist', 'index.html')
);

fs.writeFileSync(path.join(repoRoot, '.nojekyll'), '');