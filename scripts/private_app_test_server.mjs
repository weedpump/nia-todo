// Disposable full FastAPI app for E2E tests. No installed DB/service helpers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function startPrivateApp({ name = 'app', pythonPreamble = '' } = {}) {
  const privateDir = await mkdtemp(join(tmpdir(), `nia-${name}-e2e-`));
  const infoFile = join(privateDir, 'server.json');
  const setupTokenFile = join(privateDir, 'setup-token');
  const python = process.env.NIA_TODO_TEST_PYTHON || (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
  const source = `
import asyncio, json, os, socket, sys
os.umask(0o077)
${pythonPreamble}
import uvicorn
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(('127.0.0.1', 0))
with open(sys.argv[1], 'w', encoding='utf-8') as handle:
    json.dump({'port': sock.getsockname()[1]}, handle)
config = uvicorn.Config('main:app', host='127.0.0.1', log_level='error', access_log=False, lifespan='on', proxy_headers=False)
asyncio.run(uvicorn.Server(config).serve(sockets=[sock]))
`;
  const child = spawn(python, ['-c', source, infoFile], {
    cwd: join(root, 'api'), stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, PYTHONPATH: [join(root, 'api'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      NIA_TODO_DATA_DIR: privateDir, NIA_TODO_DB: join(privateDir, 'e2e.db'),
      NIA_TODO_ATTACHMENT_DIR: join(privateDir, 'attachments'), NIA_TODO_AVATAR_DIR: join(privateDir, 'avatars'),
      NIA_TODO_BACKUP_DIR: join(privateDir, 'backups'), NIA_TODO_VAPID_KEYS: join(privateDir, 'vapid.json'),
      NIA_TODO_SETUP_TOKEN_FILE: setupTokenFile, NIA_TODO_UPDATE_STATUS_FILE: join(privateDir, 'update-status.json'),
      NIA_TODO_UPDATE_PRIMARY_URL: 'http://127.0.0.1:9/disabled', NIA_TODO_UPDATE_RELEASE_API_URL: 'http://127.0.0.1:9/disabled',
      NIA_TODO_UPDATE_RELEASES_URL: 'http://127.0.0.1:9/disabled', NIA_TODO_UPDATE_UMAMI_URL: 'http://127.0.0.1:9/disabled',
      NIA_TODO_UPDATE_UMAMI_WEBSITE_ID: '', NIA_TODO_INSTALLATION_TYPE: 'dev',
    },
  });
  let spawnFailure;
  child.on('error', error => { spawnFailure = error; });
  async function stop() {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
    await rm(privateDir, { recursive: true, force: true });
  }
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (spawnFailure) throw spawnFailure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Private app exited during startup');
      try {
        const { port } = JSON.parse(await readFile(infoFile, 'utf8'));
        assert(Number.isInteger(port) && port > 0);
        const base = `http://127.0.0.1:${port}`;
        if ((await fetch(`${base}/api/setup/status`, { signal: AbortSignal.timeout(1000) })).ok) {
          const setupToken = (await readFile(setupTokenFile, 'utf8')).trim();
          assert(setupToken, 'Private setup token must exist');
          return { base, root, privateDir, setupToken, stop };
        }
      } catch { /* Startup is not ready; never print setup credentials. */ }
      await sleep(100);
    }
    throw new Error('Private app did not become ready within 45 seconds');
  } catch (error) { await stop(); throw error; }
}
