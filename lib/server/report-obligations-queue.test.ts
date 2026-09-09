import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const f = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./db', () => ({
  pool: { query: f.query },
  isOrganizationId: (id: string) => /^[a-f0-9-]{36}$/i.test(id),
}));
import {
  ensureReportObligations,
  scheduleReportObligations,
  claimReportObligations,
  finishReportObligations,
  processReportObligationsClaim,
} from './report-obligations-queue';
const org = 'a6c8ed04-e4b5-4980-ab82-d2008246c012';
const owner = 'b4c28860-f4a2-4fda-b100-eb6a55246e19';
const claim = { organizationId: org, owner, generation: '9007199254740993' };

describe('durable reporting monitor routing', () => {
  beforeEach(() => {
    f.query.mockReset();
    f.query.mockResolvedValue({ rows: [] });
  });
  it('enrolls a workspace once and wakes later work without changing an active lease', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as import('pg').PoolClient;
    await ensureReportObligations(client, org);
    expect(query.mock.calls[0][0]).toContain('DO NOTHING');
    await scheduleReportObligations(client, org);
    const [sql, values] = query.mock.calls[1];
    expect(values).toEqual([org]);
    expect(sql).toContain('generation+1');
    expect(sql).not.toMatch(/SET[\s\S]*lease_(?:owner|until)/);
    await expect(ensureReportObligations(client, 'wrong')).rejects.toThrow();
    await expect(scheduleReportObligations(client, 'wrong')).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('claims through the restricted metadata function and uses a unique owner on each claim', async () => {
    f.query.mockResolvedValue({
      rows: [
        {
          organization_id: org,
          generation: claim.generation,
          lease_owner: owner,
        },
      ],
    });
    expect(await claimReportObligations([org])).toEqual(claim);
    expect(await claimReportObligations([org])).toEqual(claim);
    expect(f.query.mock.calls[0][0]).toBe(
      'SELECT * FROM claim_report_obligations($1::uuid,$2::uuid[])',
    );
    expect(f.query.mock.calls[0][1][1]).toEqual([org]);
    expect(f.query.mock.calls[0][1][0]).not.toBe(f.query.mock.calls[1][1][0]);
    await expect(claimReportObligations([])).rejects.toThrow();
    await expect(claimReportObligations(['bad'])).rejects.toThrow();
    await expect(claimReportObligations([org, org])).rejects.toThrow();
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it('handles an empty queue and retains bigint generation without rounding', async () => {
    expect(await claimReportObligations()).toBeNull();
    f.query.mockResolvedValue({ rows: [{ finished: true }] });
    expect(await finishReportObligations(claim)).toBe(true);
    expect(f.query.mock.calls[1][1]).toEqual([
      org,
      owner,
      claim.generation,
      null,
    ]);
  });
  it('passes only the claimed tenant into reconciliation and reports an actual change', async () => {
    f.query.mockResolvedValue({ rows: [{ finished: true }] });
    const reconcile = vi.fn().mockResolvedValue({ changed: true });
    expect(await processReportObligationsClaim(claim, reconcile)).toBe(
      'changed',
    );
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(org);
    expect(f.query.mock.calls[0][1][3]).toBeNull();
  });
  it('completes no-change runs and rejects stale completion', async () => {
    const reconcile = vi.fn().mockResolvedValue({ changed: false });
    f.query.mockResolvedValueOnce({ rows: [{ finished: true }] });
    expect(await processReportObligationsClaim(claim, reconcile)).toBe(
      'unchanged',
    );
    f.query.mockResolvedValueOnce({ rows: [{ finished: false }] });
    expect(await processReportObligationsClaim(claim, reconcile)).toBe(
      'lease_lost',
    );
  });
  it('suppresses exception contents and records only the bounded retry code', async () => {
    f.query.mockResolvedValue({ rows: [{ finished: true }] });
    const reconcile = vi
      .fn()
      .mockRejectedValue(new Error('Private financial report and password'));
    expect(await processReportObligationsClaim(claim, reconcile)).toBe(
      'failed',
    );
    expect(f.query.mock.calls[0][1]).toEqual([
      org,
      owner,
      claim.generation,
      'RECONCILIATION_FAILED',
    ]);
    expect(JSON.stringify(f.query.mock.calls)).not.toContain(
      'Private financial',
    );
  });
  it('returns an unstarted claim immediately on shutdown without evaluating the workspace', async () => {
    f.query.mockResolvedValue({ rows: [{ finished: true }] });
    const reconcile = vi.fn();
    expect(
      await processReportObligationsClaim(claim, reconcile, () => true),
    ).toBe('stopped');
    expect(reconcile).not.toHaveBeenCalled();
    expect(f.query.mock.calls[0][1][3]).toBe('WORKER_STOPPING');
  });
  it('does not swallow database failures or pretend an unverified lease is complete', async () => {
    f.query.mockRejectedValue(new Error('database unavailable'));
    await expect(
      processReportObligationsClaim(claim, async () => ({ changed: true })),
    ).rejects.toThrow('database unavailable');
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('ships tenant RLS, restricted definer functions, lease and wake fencing', () => {
    const sql = readFileSync(
      new URL('../../migrations/011-report-obligations.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'SECURITY DEFINER SET search_path=pg_catalog,pg_temp',
    );
    expect(sql).toContain('FOR UPDATE SKIP LOCKED LIMIT 1');
    expect(sql).toContain("interval '90 seconds'");
    expect(sql).toContain('q.generation<>p_generation');
    expect(sql).toContain(
      'q.lease_owner=p_owner AND q.lease_until>clock_timestamp()',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION claim_report_obligations(uuid,uuid[]) FROM PUBLIC',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION finish_report_obligations(uuid,uuid,bigint,text) FROM PUBLIC',
    );
    expect(sql).not.toMatch(/ALTER TABLE app_(?:jobs|workspace|documents)\b/);
  });
});
