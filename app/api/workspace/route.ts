import { z } from 'zod';
import { readWorkspace, changeWorkspace } from '@/lib/workspace-store';
import {
  deriveWorkspace,
  initialWorkspace,
  type PortfolioRecords,
} from '@/lib/workspace';
import { rangeStartDate } from '@/lib/date-ranges';
import { aggregateRecordedMarks } from '@/lib/recorded-marks';
import { aggregateValuationHistory } from '@/lib/finance';
import {
  requireWorkspace,
  assertSameOrigin,
  AccessError,
  errorResponse,
} from '@/lib/server/access';
import { parseJson, json } from '@/lib/server/http';
import type { Holding } from '@/data';
import {
  riskActions,
  changeRiskWorkspace,
  RiskWorkspaceError,
} from '@/lib/risk-workspace';
const Action = z.discriminatedUnion('type', [
  ...riskActions,
  z.object({
    type: z.literal('task'),
    id: z.string(),
    status: z.enum(['To do', 'In progress', 'Done']),
  }),
  z.object({
    type: z.literal('review'),
    id: z.string(),
    status: z.enum(['Accepted', 'Needs review']),
  }),
  z.object({
    type: z.literal('report'),
    family: z.string().default('all'),
    range: z.enum(['YTD', '1Y']).default('YTD'),
    name: z.string().max(100).default('Portfolio report'),
  }),
  z.object({
    type: z.literal('settings'),
    name: z.string().trim().min(2).max(80),
  }),
  z.object({ type: z.literal('seed') }),
  z.object({ type: z.literal('reset') }),
  z.object({ type: z.literal('sync'), id: z.string() }),
  z.object({
    type: z.literal('addHolding'),
    name: z.string().trim().min(2).max(150),
    familyName: z.string().trim().min(2).max(80),
    assetClass: z.enum([
      'Public equities',
      'Private equity',
      'Venture capital',
      'Real estate',
      'Fixed income',
      'Cash',
    ]),
    valueEUR: z
      .number()
      .min(0)
      .max(1e12)
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.001),
    costBasisEUR: z
      .number()
      .min(0)
      .max(1e12)
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.001),
    unfundedCommitmentEUR: z
      .number()
      .min(0)
      .max(1e12)
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.001),
    valuationDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (s) =>
          Number.isFinite(Date.parse(s)) &&
          new Date(s).toISOString().slice(0, 10) === s,
      ),
  }),
]);
export async function GET(request: Request) {
  try {
    const context = await requireWorkspace(request, 'read'),
      { state } = await readWorkspace(context);
    return json({
      ...state,
      sampleDataAllowed: process.env.ASTER_ALLOW_SAMPLE_DATA === 'true',
      identity: {
        user: context.user,
        organizationId: context.organizationId,
        organizationName: state.officeName,
        role: context.role,
        dataScope: context.scope ?? null,
        mfaEnabled: true,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const context = await requireWorkspace(request, 'write'),
      input = await parseJson(request, Action);
    if (
      ['settings', 'seed', 'reset'].includes(input.type) &&
      !['owner', 'admin'].includes(context.role)
    )
      throw new AccessError(
        403,
        'ADMIN_REQUIRED',
        'An administrator must make this change.',
      );
    const state = await changeWorkspace(
      context,
      (s) => {
        const data = deriveWorkspace(s);
        switch (input.type) {
          case 'riskData':
          case 'riskScenario':
          case 'riskScenarioDelete':
            try {
              return changeRiskWorkspace(s, input);
            } catch (e) {
              if (e instanceof RiskWorkspaceError)
                throw new AccessError(
                  e.code === 'SCENARIO_NOT_FOUND' ? 404 : 400,
                  e.code,
                  e.message,
                );
              throw e;
            }
          case 'task':
            if (!data.tasks.some((t) => t.id === input.id))
              throw new AccessError(404, 'TASK_NOT_FOUND', 'Task not found.');
            return {
              ...s,
              taskStatus: { ...s.taskStatus, [input.id]: input.status },
            };
          case 'review':
            if (!data.evidence.some((t) => t.id === input.id))
              throw new AccessError(
                404,
                'SOURCE_NOT_FOUND',
                'Source not found.',
              );
            return {
              ...s,
              reviews: { ...s.reviews, [input.id]: input.status },
            };
          case 'settings':
            return { ...s, officeName: input.name };
          case 'seed':
            if (
              s.obligations?.schedules.length ||
              s.obligations?.exceptions.length
            )
              throw new AccessError(
                409,
                'REPORT_HISTORY_RETAINED',
                'Reporting expectations and exception history must be retained. Use a separate empty workspace for sample data.',
              );
            if (process.env.ASTER_ALLOW_SAMPLE_DATA !== 'true')
              throw new AccessError(
                403,
                'SAMPLES_DISABLED',
                'Sample data is disabled for this deployment.',
              );
            if (data.holdings.length || data.evidence.length)
              throw new AccessError(
                409,
                'WORKSPACE_NOT_EMPTY',
                'Sample data can only be loaded into an empty workspace.',
              );
            return { ...initialWorkspace(true), officeName: s.officeName };
          case 'reset':
            if (
              s.obligations?.schedules.length ||
              s.obligations?.exceptions.length
            )
              throw new AccessError(
                409,
                'REPORT_HISTORY_RETAINED',
                'Reporting expectations and exception history must be retained. Use a separate workspace for a new demo.',
              );
            if (!s.sampleData || data.evidence.some((e) => !e.synthetic))
              throw new AccessError(
                403,
                'RESET_DISABLED',
                'Live portfolios cannot be reset.',
              );
            return { ...initialWorkspace(false), officeName: s.officeName };
          case 'sync':
            if (!s.sampleData || !data.mailboxes.some((m) => m.id === input.id))
              throw new AccessError(
                400,
                'NOT_A_SAMPLE_CONNECTION',
                'No sample connection matches this request.',
              );
            return {
              ...s,
              syncs: { ...s.syncs, [input.id]: new Date().toISOString() },
            };
          case 'addHolding': {
            const records: PortfolioRecords = {
              holdings: [...data.holdings],
              history: [...data.history],
              events: [...data.events],
              evidence: [...data.evidence],
              tasks: [...data.tasks],
              families: [...data.families],
              entities: [...data.entities],
              accounts: [...data.accounts],
            };
            let family = records.families.find(
              (f) => f.name.toLowerCase() === input.familyName.toLowerCase(),
            );
            if (!family) {
              family = {
                id: crypto.randomUUID(),
                name: input.familyName,
                initials: input.familyName.slice(0, 2).toUpperCase(),
                principal: '',
                location: '',
                color: '#8064e5',
              };
              records.families.push(family);
            }
            const id = crypto.randomUUID(),
              entityId = crypto.randomUUID(),
              accountId = crypto.randomUUID(),
              sourceId = 'manual-' + id;
            records.entities.push({
              id: entityId,
              familyId: family.id,
              name: family.name + ' investment records',
              type: 'Holding company',
              jurisdiction: 'Unspecified',
              ownershipPercent: 100,
            });
            records.accounts.push({
              id: accountId,
              familyId: family.id,
              entityId,
              name: 'Manually maintained',
              institution: 'Manual records',
              maskedNumber: '',
              type: 'Private investments',
            });
            const h: Holding = {
              id,
              name: input.name,
              assetClass: input.assetClass,
              familyId: family.id,
              entityId,
              accountId,
              currency: 'EUR',
              valueEUR: input.valueEUR,
              costBasisEUR: input.costBasisEUR,
              originalValue: input.valueEUR,
              syntheticFXRateToEUR: 1,
              unfundedCommitmentEUR: input.unfundedCommitmentEUR,
              liquidityBucket:
                input.assetClass === 'Cash' ? 'Daily' : '3+ years',
              valuationDate: input.valuationDate,
              sourceId,
              geography: 'Unspecified',
              manager: 'Unspecified',
              description:
                'Entered by ' +
                context.user.name +
                '. Ownership, liquidity and source details require independent verification.',
              color: '#8064e5',
              valuationMethod:
                input.assetClass === 'Cash'
                  ? 'Cash balance'
                  : 'Reported fund NAV',
            };
            records.holdings.push(h);
            records.history.push({
              holdingId: id,
              date: input.valuationDate,
              valueEUR: input.valueEUR,
              netExternalFlowEUR: 0,
              valuationBasis: 'Reported mark',
            });
            records.evidence.push({
              id: sourceId,
              mailboxId: 'manual',
              familyId: family.id,
              holdingId: id,
              subject: 'Manual opening position: ' + input.name,
              sender: context.user.name,
              receivedAt: new Date().toISOString(),
              effectiveDate: input.valuationDate,
              filename: 'manual-record.txt',
              page: 1,
              excerpt:
                'Manually entered EUR value ' +
                input.valueEUR.toFixed(2) +
                ', cost basis ' +
                input.costBasisEUR.toFixed(2) +
                ', unfunded commitment ' +
                input.unfundedCommitmentEUR.toFixed(2) +
                '. This entry is not independent source evidence.',
              status: 'Needs review',
              synthetic: false,
            });
            return { ...s, portfolio: records };
          }
          case 'report': {
            if (s.reports.length >= 40)
              throw new AccessError(
                409,
                'REPORT_LIMIT',
                'This workspace has reached its 40-report snapshot limit. Existing reports are preserved.',
              );
            if (
              input.family !== 'all' &&
              !data.families.some((f) => f.id === input.family)
            )
              throw new AccessError(
                400,
                'INVALID_FAMILY',
                'Choose a family in this workspace.',
              );
            const positions = data.holdings.filter(
              (h) => input.family === 'all' || h.familyId === input.family,
            );
            const completeSample =
              s.sampleData && !data.evidence.some((e) => !e.synthetic);
            const asOf = completeSample
                ? '2026-09-07'
                : new Date().toISOString().slice(0, 10),
              start = rangeStartDate(asOf, input.range);
            const points = aggregateValuationHistory(
                data.history,
                positions.map((h) => h.id),
                'daily',
              ).filter((p) => p.date >= start),
              base = points[0]?.twrIndex;
            const history = completeSample
              ? points
                  .filter((_, i) => i % 5 === 0 || i === points.length - 1)
                  .map((p) => ({
                    date: p.date,
                    value: p.valueEUR,
                    flow: p.netExternalFlowEUR,
                    index:
                      base && p.twrIndex !== null
                        ? (p.twrIndex / base) * 100
                        : null,
                  }))
              : aggregateRecordedMarks(
                  data.history,
                  positions.map((h) => h.id),
                  start,
                );
            return {
              ...s,
              reports: [
                {
                  id: crypto.randomUUID(),
                  synthetic: !!completeSample,
                  name: input.name,
                  family: input.family,
                  range: input.range,
                  createdAt: new Date().toISOString(),
                  totalValueEUR: positions.reduce((v, h) => v + h.valueEUR, 0),
                  holdingCount: positions.length,
                  holdings: positions,
                  history,
                },
                ...s.reports,
              ],
            };
          }
        }
      },
      'workspace.' + input.type,
    );
    return json({
      ...state,
      sampleDataAllowed: process.env.ASTER_ALLOW_SAMPLE_DATA === 'true',
      identity: {
        user: context.user,
        organizationId: context.organizationId,
        organizationName: state.officeName,
        role: context.role,
        mfaEnabled: true,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
