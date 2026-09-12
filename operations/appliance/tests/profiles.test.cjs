// Read-only composition contract tests. Actual Docker routing/TLS checks are separate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const load = mode => yaml.load(fs.readFileSync(path.join(root, 'config', `compose.${mode}.yaml`), 'utf8'));

test('offline profile contains only internal networks and no collectors or cloud fallback', () => {
  const config = load('offline');
  assert.equal(config.services['mailbox-worker'], undefined);
  assert.equal(config.services['delivery-worker'], undefined);
  for (const n of Object.values(config.networks)) assert.equal(n.internal, true);
  for (const s of Object.values(config.services)) {
    assert.deepEqual(s.dns, ['127.0.0.1'], 'prevent embedded DNS forwarding to host resolvers');
    assert.ok(s.networks.every(n => config.networks[n]?.internal));
  }
  for (const name of ['web', 'worker', 'processor']) assert.equal(config.services[name].environment.ALLOW_CLOUD_ENGINES, 'false');
  assert.equal(config.services.ollama.environment.OLLAMA_NO_CLOUD, '1');
  assert.equal(config.services.web.environment.EMAIL_DELIVERY_ENABLED, 'false');
  assert.equal(config.services.web.environment.MAILBOX_OAUTH_TRANSPORT, 'disabled');
  assert.equal(config.secrets.mailbox_broker_token, undefined);
});

test('connected collectors are explicit and cannot reach private inference', () => {
  const config = load('connected');
  for (const [name, profile, network] of [['mailbox-worker', 'mailbox', 'mail-egress'], ['delivery-worker', 'delivery', 'delivery-egress']]) {
    assert.deepEqual(config.services[name].profiles, [profile]);
    assert.deepEqual(config.services[name].networks, ['database', network]);
  }
  for (const name of ['web', 'worker', 'processor', 'ollama']) {
    assert.ok(config.services[name].networks.every(n => config.networks[n].internal));
  }
});

test('connected OAuth broker has one internal listener and a dedicated secret limited to web/mailbox', () => {
  const config = load('connected');
  const web = config.services.web, mailbox = config.services['mailbox-worker'];
  assert.equal(web.environment.MAILBOX_OAUTH_TRANSPORT, '${MAILBOX_OAUTH_TRANSPORT:-disabled}');
  assert.equal(web.environment.MAILBOX_BROKER_URL, 'http://mailbox-worker:8010');
  assert.equal(mailbox.environment.MAILBOX_BROKER_LISTEN_PORT, '8010');
  assert.equal(mailbox.environment.MAILBOX_BROKER_ORIGIN, web.environment.BETTER_AUTH_URL);
  assert.equal(mailbox.ports, undefined);
  for (const [name, service] of Object.entries(config.services)) {
    const secrets = (service.secrets || []).map(secret => typeof secret === 'string' ? secret : secret.source);
    assert.equal(secrets.includes('mailbox_broker_token'), ['web', 'mailbox-worker'].includes(name));
    if (name === 'mailbox-worker') {
      assert.ok(!secrets.includes('processor_token'));
      assert.ok(!secrets.includes('better_auth_secret'));
      assert.ok(!service.networks.includes('local-confidential'));
    }
  }
  assert.deepEqual(web.dns, ['127.0.0.1']);
});

for (const mode of ['offline', 'connected']) {
  test(`${mode}: immutable images, minimal privileges, protected Unix ingress and no published container ports`, () => {
    const config = load(mode);
    assert.equal(config.volumes, undefined);
    const required = ['postgres', 'web', 'worker', 'folder-worker', 'archive-worker', 'report-obligations-worker', 'migrate', 'processor', 'ollama', 'caddy'];
    for (const name of required) assert.ok(config.services[name]);
    for (const [name, s] of Object.entries(config.services)) {
      assert.equal(s.build, undefined);
      assert.equal(s.pull_policy, 'never');
      assert.equal(s.platform, 'linux/amd64');
      assert.ok(s.image.includes(':?Set verified'));
      assert.equal(s.read_only, true);
      assert.deepEqual(s.cap_drop, ['ALL']);
      assert.ok(s.security_opt.includes('no-new-privileges:true'));
      assert.notEqual(s.user, 'root');
      assert.equal(s.ports, undefined);
      assert.equal(s.network_mode, undefined);
      for (const v of s.volumes || []) {
        assert.equal(v.type, 'bind');
        assert.equal(v.bind.create_host_path, false);
        const ingress = name === 'caddy' && v.target === '/run/aster-ingress';
        assert.ok(v.source.startsWith('${ASTER_DATA_ROOT:') || v.source.startsWith('${ASTER_RELEASE_ROOT:') ||
          (ingress && v.source === '${ASTER_INGRESS_ROOT:?Set protected ingress socket directory}'));
        assert.ok(!v.target.includes('docker.sock'));
      }
      if (s.environment?.DB_USER === 'aster_runtime') {
        for (const key of ['ASTER_RELEASE_ID', 'ASTER_WRITER_GENERATION', 'ASTER_SCHEMA_MIN', 'ASTER_SCHEMA_MAX']) assert.ok(s.environment[key]);
      }
    }
    assert.equal(config.services.caddy.profiles, undefined, 'TLS must start by default');
    assert.deepEqual(config.services.caddy.networks, ['edge']);
    assert.equal(config.networks.edge.internal, true);
    const sockets = config.services.caddy.volumes.filter(v => v.target === '/run/aster-ingress');
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].read_only, false, 'Caddy alone creates the protected sockets');
    assert.ok(config.services.caddy.volumes.some(v => v.target === '/etc/aster/headers.caddy' && v.read_only));
    assert.equal(config.services.ollama.volumes[0].target, '/models');
  });
}

test('both TLS modes work without ACME and preserve independent private CA state', () => {
  const local = fs.readFileSync(path.join(root, 'config/Caddyfile.internal'), 'utf8');
  const supplied = fs.readFileSync(path.join(root, 'config/Caddyfile.supplied'), 'utf8');
  assert.match(local, /tls internal/);
  assert.match(local, /skip_install_trust/);
  assert.match(supplied, /auto_https off/);
  assert.match(supplied, /tls \/etc\/aster\/tls\/server.crt \/etc\/aster\/tls\/server.key/);
  for (const content of [local, supplied]) {
    assert.doesNotMatch(content, /acme_ca|acme_email|issuer acme/i);
    assert.match(content, /header_up X-Real-IP \{remote_host\}/);
    assert.match(content, /redir \{\$ASTER_ORIGIN\}\{uri\}/);
    assert.match(content, /bind unix\/\/run\/aster-ingress\/https\.sock\|0200/);
    assert.match(content, /bind unix\/\/run\/aster-ingress\/http\.sock\|0200/);
    assert.equal((content.match(/^\s*bind /gm) || []).length, 2);
    assert.match(content, /protocols h1 h2\s/);
    assert.doesNotMatch(content, /protocols[^\n]*\bh3\b/);
    assert.match(content, /listener_wrappers\s*\{\s*proxy_protocol\s*\{[^}]*fallback_policy reject[^}]*\}\s*tls\s*\}/);
  }
});
