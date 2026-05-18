import http.server
import socketserver
import webbrowser
import os
import sys
import subprocess
import shutil
import stat
from functools import partial
from pathlib import Path

PORT = 8000
ROOT_DIR = Path(__file__).resolve().parent
WEB_DIR = ROOT_DIR / 'web'
BUILD_DIR = WEB_DIR / 'dist'
SVELTE_OUTPUT_DIR = WEB_DIR / '.svelte-kit-build' / 'output'


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


def _remove_readonly(func, path, _exc_info):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def run_frontend_build(npm_cmd):
    return subprocess.run(
        [npm_cmd, 'run', 'build'],
        cwd=WEB_DIR,
        check=True,
        capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
    )


def build_frontend():
    npm_cmd = 'npm.cmd' if os.name == 'nt' else 'npm'

    if not WEB_DIR.is_dir():
        raise FileNotFoundError(f'Web app directory not found: {WEB_DIR}')

    print(f'Building frontend from {WEB_DIR}...')
    try:
        result = run_frontend_build(npm_cmd)
    except FileNotFoundError as exc:
        raise RuntimeError('npm is not installed or not on PATH') from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr or ''
        stdout = exc.stdout or ''
        if 'EPERM' in stderr and '.svelte-kit' in stderr and SVELTE_OUTPUT_DIR.exists():
            print(f'Build hit a locked {SVELTE_OUTPUT_DIR}; clearing it and retrying once...')
            shutil.rmtree(SVELTE_OUTPUT_DIR, onerror=_remove_readonly)
            try:
                result = run_frontend_build(npm_cmd)
            except subprocess.CalledProcessError as retry_exc:
                if retry_exc.stdout:
                    print(retry_exc.stdout)
                if retry_exc.stderr:
                    print(retry_exc.stderr, file=sys.stderr)
                raise RuntimeError('Frontend build failed after retry') from retry_exc
        else:
            if stdout:
                print(stdout)
            if stderr:
                print(stderr, file=sys.stderr)
            raise RuntimeError('Frontend build failed') from exc

    if result.stdout:
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        if lines:
            print(lines[-1])

    if not (BUILD_DIR / 'index.html').is_file():
        raise RuntimeError(f'Build completed but {BUILD_DIR / "index.html"} was not found')

def run_server():
    build_frontend()

    handler = partial(NoCacheHandler, directory=str(BUILD_DIR))
    
    # Allow address reuse to avoid "Address already in use" errors on restart
    socketserver.TCPServer.allow_reuse_address = True
    
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"Serving {BUILD_DIR} at http://localhost:{PORT}")
        print("Opening browser...")
        webbrowser.open(f"http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server...")
            httpd.shutdown()

if __name__ == "__main__":
    run_server()
