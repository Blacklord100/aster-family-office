"""Load one Docker secret and exec the approved processor without a shell."""
import os
from pathlib import Path
import sys

COMMAND = ['uvicorn', 'service.app:create_app', '--factory', '--host', '0.0.0.0',
           '--port', '8000', '--workers', '1', '--no-access-log', '--limit-concurrency',
           '8', '--timeout-keep-alive', '5']


def main():
    if sys.argv[1:] != COMMAND:
        raise ValueError('Only the approved processor service command is supported')
    source = os.environ.pop('PROCESSOR_TOKEN_FILE', '')
    if not source or os.environ.get('PROCESSOR_TOKEN'):
        raise ValueError('Configure exactly one processor token file')
    with Path(source).open('rb') as handle:
        raw = handle.read(4097)
    token = raw.rstrip(b'\r\n')
    if len(raw) > 4096 or not 32 <= len(token) <= 4096 or any(value < 33 or value > 126 for value in token):
        raise ValueError('Processor token must contain 32 to 4096 printable non-space ASCII characters')
    os.environ['PROCESSOR_TOKEN'] = token.decode('ascii')
    os.execv(sys.executable, [sys.executable, '-m', 'uvicorn', *COMMAND[1:]])


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError):
        print('Processor startup failed: check the secret file and approved service command.', file=sys.stderr)
        sys.exit(1)
