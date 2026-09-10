import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { WorkspaceContext } from './access';
const mocks = vi.hoisted(() => ({
  verified: vi.fn(),
  workspace: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./demo-review-policy', () => ({
  hasDemoSourceVerification: mocks.verified,
}));
vi.mock('../workspace-store', () => ({
  readWorkspaceInTransaction: mocks.workspace,
}));
vi.mock('./demo-corpus', () => ({ loadDemoCatalog: mocks.catalog }));
import { verifiedDemoIndexSource } from './demo-index-policy';
const context = { organizationId: 'synthetic-history' } as WorkspaceContext;
const client = {} as PoolClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verified.mockResolvedValue(true);
  mocks.workspace.mockResolvedValue({
    state: {
      demo: {
        dataset: 'history-v1',
        runId: context.organizationId,
        autoPublish: true,
      },
    },
  });
  mocks.catalog.mockImplementation(async (dataset) => ({
    documents:
      dataset === 'history-v1' ? [{ sha256: 'retained-history-hash' }] : [],
  }));
});
describe('pinned demo indexing quota', () => {
  it('uses the history dataset rather than silently falling back to the mailroom catalog', async () => {
    expect(
      await verifiedDemoIndexSource(
        client,
        context,
        'source',
        'retained-history-hash',
      ),
    ).toBe(true);
    expect(mocks.catalog).toHaveBeenCalledWith('history-v1');
  });
  it('never gives the automation quota to an unverified source or unrelated workspace', async () => {
    mocks.verified.mockResolvedValueOnce(false);
    expect(
      await verifiedDemoIndexSource(
        client,
        context,
        'source',
        'retained-history-hash',
      ),
    ).toBe(false);
    expect(mocks.workspace).not.toHaveBeenCalled();
    mocks.workspace.mockResolvedValueOnce({
      state: { demo: { runId: 'another-office', autoPublish: true } },
    });
    expect(
      await verifiedDemoIndexSource(
        client,
        context,
        'source',
        'retained-history-hash',
      ),
    ).toBe(false);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it('requires an exact original hash in the pinned catalog and active automation', async () => {
    expect(
      await verifiedDemoIndexSource(client, context, 'source', 'foreign-hash'),
    ).toBe(false);
    mocks.workspace.mockResolvedValueOnce({
      state: { demo: { runId: context.organizationId, autoPublish: false } },
    });
    expect(
      await verifiedDemoIndexSource(
        client,
        context,
        'source',
        'retained-history-hash',
      ),
    ).toBe(false);
  });
});
