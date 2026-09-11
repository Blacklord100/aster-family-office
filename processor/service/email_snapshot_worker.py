"""Short-lived renderer; no engine imports, credentials, HTTP or remote content."""
import json
import resource
import sys


def main():
    resource.setrlimit(resource.RLIMIT_CPU, (16, 16))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
    if sys.platform == 'linux':
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    from .email_snapshot import EmailSnapshotRequest, REQUEST_BYTES, render_email_snapshot
    # Allow the small trusted operation/query envelope added after HTTP bounds.
    raw = sys.stdin.buffer.read(REQUEST_BYTES + 4097)
    if len(raw) > REQUEST_BYTES + 4096:
        raise ValueError('Snapshot worker input limit exceeded')
    request = json.loads(raw)
    return render_email_snapshot(EmailSnapshotRequest.model_validate(request['query']))


if __name__ == '__main__':
    try:
        print(main().model_dump_json())
    except Exception:
        # Never include input text, local paths or parser diagnostics.
        print(json.dumps({'inputError': 'Email copy could not be rendered within safety limits'}))
