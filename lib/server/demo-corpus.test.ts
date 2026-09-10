import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
vi.mock('server-only', () => ({}));
import {
  demoCatalogSchema,
  loadDemoCatalog,
  readDemoSource,
  demoCorpusRoot,
} from './demo-corpus';
import { sha256 } from './crypto';
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function corpus() {
  return JSON.parse(
    await readFile('benchmark/mailroom-v1/catalog.json', 'utf8'),
  );
}
describe('fixed demo corpus boundary', () => {
  it('validates the shipped100 originals without reading the benchmark answer key', async () => {
    const catalog = await loadDemoCatalog();
    expect(catalog.documents).toHaveLength(100);
    for (const document of catalog.documents)
      expect(sha256(await readDemoSource(document))).toBe(document.sha256);
  });
  it('validates the separately pinned history sources and keeps legacy defaults isolated', async () => {
    const [legacy, history] = await Promise.all([
      loadDemoCatalog(),
      loadDemoCatalog('history-v1'),
    ]);
    expect(history.documents).toHaveLength(100);
    expect(new Set(history.documents.map((source) => source.sha256)).size).toBe(
      97,
    );
    expect(history.offices.map((office) => office.id)).toEqual([
      'harbor-family',
      'maple-family',
      'willow-family',
    ]);
    expect(legacy.offices[0].id).toBe('alder-house');
    for (const document of history.documents)
      expect(sha256(await readDemoSource(document, 'history-v1'))).toBe(
        document.sha256,
      );
    await expect(readDemoSource(history.documents[0])).rejects.toThrow();
    expect(() => demoCorpusRoot('../outside' as 'history-v1')).toThrow();
    expect('gold' in history).toBe(false);
  });
  it('rejects path traversal, duplicate sources and cross-family routing', async () => {
    const original = await corpus();
    for (const mutate of [
      (v: typeof original) => {
        v.documents[0].path = '../private.eml';
      },
      (v: typeof original) => {
        v.documents[0].office_id = '../../outside';
      },
      (v: typeof original) => {
        v.mailboxes[0].id = '../outside';
      },
      (v: typeof original) => {
        v.documents[1].path = v.documents[0].path;
      },
      (v: typeof original) => {
        v.offices[1].id = v.offices[0].id;
      },
      (v: typeof original) => {
        v.documents[0].office_id = v.offices.find(
          (office: { id: string }) => office.id !== v.documents[0].office_id,
        ).id;
      },
    ]) {
      const value = structuredClone(original);
      mutate(value);
      expect(demoCatalogSchema.safeParse(value).success).toBe(false);
    }
  });
  it('rejects symbolic sources and content substitution before importing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aster-demo-source-'));
    temporary.push(root);
    vi.stubEnv('ASTER_DEMO_CORPUS_ROOT', root);
    await mkdir(path.join(root, 'fixtures/emails'), { recursive: true });
    const bytes = Buffer.from('Synthetic original');
    const document = {
      path: 'fixtures/emails/synthetic.eml',
      office_id: 'family',
      mailbox_id: 'mailbox',
      sha256: sha256(bytes),
    };
    await writeFile(path.join(root, 'outside.eml'), bytes);
    await symlink(
      path.join(root, 'outside.eml'),
      path.join(root, document.path),
    );
    await expect(readDemoSource(document)).rejects.toThrow('DEMO_CORPUS_PATH');
    await rm(path.join(root, document.path));
    await writeFile(path.join(root, document.path), 'Changed source');
    await expect(readDemoSource(document)).rejects.toThrow(
      'DEMO_CORPUS_CHANGED',
    );
  });
});
