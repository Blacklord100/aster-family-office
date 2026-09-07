import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
if (process.env.NODE_ENV === 'production')
  throw new Error('Use the private processor container for production.');
const python = resolve(
  process.env.ASTER_PYTHON ?? 'processor/.venv/bin/python',
);
const child = spawn(
  python,
  [
    '-m',
    'uvicorn',
    'service.app:create_app',
    '--factory',
    '--host',
    '127.0.0.1',
    '--port',
    '8000',
    '--workers',
    '1',
    '--no-access-log',
  ],
  {
    cwd: 'processor',
    env: { ...process.env, OLLAMA_NO_CLOUD: '1' },
    stdio: 'inherit',
  },
);
child.on('error', () => {
  console.error(
    'Processor could not start. Create processor/.venv with Python3.12 and install requirements.lock.txt.',
  );
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
