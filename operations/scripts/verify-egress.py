"""Run inside processor after deployment; probes transport only, never sends documents."""
import json
import socket
import sys
import urllib.error
import urllib.request

results = []
# Direct addresses distinguish internet routing from DNS failure. Metadata is never requested.
for label, host, port in [('external_tls', '1.1.1.1', 443), ('external_http', '1.1.1.1', 80), ('metadata_transport', '169.254.169.254', 80)]:
    try:
        with socket.create_connection((host, port), timeout=3):
            reached = True
    except OSError:
        reached = False
    results.append({'check': label, 'blocked': not reached})
try:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('https://example.com', timeout=4):
        reached = True
except urllib.error.HTTPError:
    reached = True
except (OSError, urllib.error.URLError):
    reached = False
results.append({'check': 'public_hostname_tls', 'blocked': not reached})
print(json.dumps({'result': 'passed' if all(r['blocked'] for r in results) else 'failed', 'checks': results, 'scope': 'bounded connection probes; firewall and proxy review still required'}))
sys.exit(0 if all(r['blocked'] for r in results) else 1)
