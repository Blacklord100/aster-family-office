import { describe, expect, it } from 'vitest';
import type { DemoCatalog } from './demo-corpus';
import { demoQueueOffset } from './folder-queue-order';
const catalog: DemoCatalog = {
  offices: ['alder', 'belwick', 'cinder'].map((id) => ({
    id,
    name: id,
    names: [id],
    currency: 'EUR',
  })),
  mailboxes: [],
  documents: ['alder', 'belwick', 'cinder'].flatMap((office_id) =>
    [0, 1, 2].map((ordinal) => ({
      office_id,
      mailbox_id: office_id,
      path: 'fixtures/emails/' + office_id + ordinal + '.eml',
      sha256: office_id + ordinal,
    })),
  ),
};
describe('verified demo family scheduling', () => {
  it('interleaves families deterministically from routing metadata', () => {
    const hashes = catalog.documents
      .map((document) => document.sha256)
      .sort(
        (a, b) => demoQueueOffset(catalog, a)! - demoQueueOffset(catalog, b)!,
      );
    expect(hashes).toEqual([
      'alder0',
      'belwick0',
      'cinder0',
      'alder1',
      'belwick1',
      'cinder1',
      'alder2',
      'belwick2',
      'cinder2',
    ]);
  });
  it('leaves unknown originals and ambiguous cross-family copies on normal scheduling', () => {
    expect(demoQueueOffset(catalog, 'real-unknown-original')).toBeNull();
    expect(
      demoQueueOffset(
        {
          ...catalog,
          documents: [
            ...catalog.documents,
            { ...catalog.documents[0], office_id: 'belwick' },
          ],
        },
        'alder0',
      ),
    ).toBeNull();
  });
  it('keeps repeated copies within one family at their first stable ordinal', () => {
    expect(
      demoQueueOffset(
        {
          ...catalog,
          documents: [
            ...catalog.documents,
            { ...catalog.documents[1], path: 'fixtures/emails/duplicate.eml' },
          ],
        },
        'alder1',
      ),
    ).toBe(3);
  });
});
