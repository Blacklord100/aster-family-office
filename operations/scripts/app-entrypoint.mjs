import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

function secret(name) {
  const file = process.env[name + '_FILE'];
  const direct = process.env[name];
  if (file && direct)
    throw new Error('Configure either ' + name + ' or its _FILE, not both');
  const value = file ? readFileSync(file, 'utf8').trim() : direct;
  if (!value) throw new Error('Missing required secret: ' + name);
  process.env[name] = value;
  delete process.env[name + '_FILE'];
  return value;
}
try {
  if (process.env.SMTP_SETTINGS_FILE) {
    const raw = readFileSync(process.env.SMTP_SETTINGS_FILE, 'utf8');
    if (raw.length > 65536) throw new Error('SMTP configuration is too large');
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error('Invalid SMTP JSON');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('Invalid SMTP configuration');
    for (const [key, value] of Object.entries(config)) {
      if (
        ![
          'SMTP_HOST',
          'SMTP_PORT',
          'SMTP_USER',
          'SMTP_PASSWORD',
          'SMTP_FROM',
        ].includes(key) ||
        typeof value !== 'string' ||
        value.length > 20000 ||
        process.env[key]
      )
        throw new Error('Invalid or duplicated SMTP setting');
      process.env[key] = value;
    }
    delete process.env.SMTP_SETTINGS_FILE;
  }
  if (process.env.ENCRYPTION_KEYRING_FILE) secret('ENCRYPTION_KEYRING');
  if (process.env.MAILBOX_PROVIDERS_FILE) {
    const raw = readFileSync(process.env.MAILBOX_PROVIDERS_FILE, 'utf8');
    if (raw.length > 65536)
      throw new Error('Mailbox provider configuration is too large');
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error('Invalid mailbox provider JSON');
    }
    const allowed = [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'MICROSOFT_CLIENT_ID',
      'MICROSOFT_CLIENT_SECRET',
      'MICROSOFT_TENANT_ID',
    ];
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('Invalid mailbox provider configuration');
    for (const [key, value] of Object.entries(config)) {
      if (
        !allowed.includes(key) ||
        typeof value !== 'string' ||
        value.length > 20000
      )
        throw new Error('Invalid mailbox provider setting');
      if (process.env[key])
        throw new Error('Configure provider credentials in one place only');
      process.env[key] = value;
    }
    delete process.env.MAILBOX_PROVIDERS_FILE;
  }
  if (process.env.DB_PASSWORD_FILE) {
    if (process.env.DATABASE_URL)
      throw new Error(
        'Configure either DATABASE_URL or DB_PASSWORD_FILE, not both',
      );
    const password = secret('DB_PASSWORD');
    const url = new URL('postgresql://postgres:5432/aster');
    url.username = process.env.DB_USER || 'aster_runtime';
    url.password = password;
    url.hostname = process.env.DB_HOST || 'postgres';
    url.port = process.env.DB_PORT || '5432';
    url.pathname = '/' + (process.env.DB_NAME || 'aster');
    process.env.DATABASE_URL = url.toString();
    delete process.env.DB_PASSWORD;
  }
  if (process.env.ASTER_DB_MIGRATION === '1') {
    if (
      process.env.MIGRATION_DATABASE_URL ||
      process.env.BOOTSTRAP_DATABASE_URL
    )
      throw new Error(
        'Migration mode requires one database configuration source',
      );
    process.env.MIGRATION_DATABASE_URL = process.env.DATABASE_URL;
    process.env.BOOTSTRAP_DATABASE_URL = process.env.DATABASE_URL;
  }
  if (
    ![
      'mailbox',
      'folder',
      'archive',
      'delivery',
      'report-obligations',
    ].includes(process.env.ASTER_SERVICE)
  ) {
    const auth = secret('BETTER_AUTH_SECRET');
    if (auth.length < 32)
      throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
    secret('PROCESSOR_TOKEN');
  }
  if (process.env.ASTER_SERVICE === 'archive') secret('PROCESSOR_TOKEN');
  const encryption = secret('ENCRYPTION_KEY');
  if (Buffer.from(encryption, 'base64').length !== 32)
    throw new Error('ENCRYPTION_KEY must encode 32 bytes');
  let keyring = {};
  if (process.env.ENCRYPTION_KEYRING) {
    try {
      keyring = JSON.parse(process.env.ENCRYPTION_KEYRING);
    } catch {
      throw new Error('Invalid encryption keyring');
    }
    if (
      !keyring ||
      typeof keyring !== 'object' ||
      Array.isArray(keyring) ||
      Object.keys(keyring).length > 20
    )
      throw new Error('Invalid encryption keyring');
    for (const [id, value] of Object.entries(keyring))
      if (
        !/^[A-Za-z0-9_-]{1,32}$/.test(id) ||
        id === 'legacy' ||
        typeof value !== 'string' ||
        Buffer.from(value, 'base64').length !== 32
      )
        throw new Error('Invalid encryption keyring');
  }
  const active = process.env.ENCRYPTION_ACTIVE_KEY_ID ?? 'legacy';
  if (active !== 'legacy' && !Object.hasOwn(keyring, active))
    throw new Error('Active encryption key is unavailable');
  const args = process.argv.slice(2);
  if (!args.length) throw new Error('Missing service command');
  const child = spawn(args[0], args.slice(1), {
    stdio: 'inherit',
    env: process.env,
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => child.kill(signal));
  child.on('error', () => {
    console.error('Aster service could not start');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 1);
  });
} catch (error) {
  console.error(
    error instanceof Error && !('path' in error)
      ? error.message
      : 'Could not read required secret file',
  );
  process.exitCode = 1;
}
