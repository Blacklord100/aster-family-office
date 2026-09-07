import { readWorkspace, changeWorkspace } from '@/lib/workspace-store';
import { startDemoRun, advanceDemoRun, cancelDemoRun } from '@/lib/demo-engine';
import { scenario, deriveWorkspace, initialWorkspace } from '@/lib/workspace';
import { tasks, evidenceSources, sources } from '@/data';
import { aggregateValuationHistory } from '@/lib/finance';
const inputString = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;
export async function GET() {
  try {
    return Response.json((await readWorkspace()).state, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json(
      { error: 'The workspace could not be loaded. Please retry.' },
      { status: 503 },
    );
  }
}
export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin)
      return Response.json(
        { error: 'Invalid request origin' },
        { status: 403 },
      );
    const text = await request.text();
    if (text.length > 8000)
      return Response.json({ error: 'Request is too large' }, { status: 413 });
    const input = JSON.parse(text) as Record<string, unknown>;
    const now = new Date().toISOString();
    const state = await changeWorkspace((s) => {
      switch (input.type) {
        case 'task': {
          if (
            !tasks.some((t) => t.id === input.id) ||
            !['To do', 'In progress', 'Done'].includes(String(input.status))
          )
            throw new Error('Invalid task update');
          return {
            ...s,
            taskStatus: {
              ...s.taskStatus,
              [String(input.id)]: String(input.status),
            },
          };
        }
        case 'review': {
          if (
            ![...evidenceSources, ...scenario.evidenceSources].some(
              (e) => e.id === input.id,
            ) ||
            !['Accepted', 'Needs review'].includes(String(input.status))
          )
            throw new Error('Invalid source review');
          return {
            ...s,
            reviews: { ...s.reviews, [String(input.id)]: String(input.status) },
          };
        }
        case 'run': {
          if (s.engine.runs.some((r) => r.status === 'running')) return s;
          if (typeof input.id !== 'string' || input.id.length > 100)
            throw new Error('Invalid run');
          return {
            ...s,
            engine: startDemoRun(s.engine, {
              runId: input.id,
              now,
              proposals: scenario.proposals,
            }),
          };
        }
        case 'advance': {
          if (
            typeof input.id !== 'string' ||
            !s.engine.runs.some((r) => r.id === input.id)
          )
            throw new Error('Unknown run');
          return {
            ...s,
            engine: advanceDemoRun(s.engine, { runId: input.id, now }),
          };
        }
        case 'cancel': {
          if (
            typeof input.id !== 'string' ||
            !s.engine.runs.some((r) => r.id === input.id)
          )
            throw new Error('Unknown run');
          return {
            ...s,
            engine: cancelDemoRun(s.engine, { runId: input.id, now }),
          };
        }
        case 'sync': {
          if (!sources.some((m) => m.id === input.id))
            throw new Error('Unknown mailbox');
          return { ...s, syncs: { ...s.syncs, [String(input.id)]: now } };
        }
        case 'report': {
          if (!['YTD', '1Y'].includes(inputString(input.range, 'YTD')))
            throw new Error('Unsupported report period');
          const family = inputString(input.family, 'all');
          if (!['all', 'laurent', 'bergstrom', 'chen'].includes(family))
            throw new Error('Invalid family');
          const derived = deriveWorkspace(s);
          const positions = derived.holdings.filter(
            (h) => family === 'all' || h.familyId === family,
          );
          const points = aggregateValuationHistory(
            derived.history,
            positions.map((h) => h.id),
            'daily',
          ).filter(
            (p) =>
              p.date >= (input.range === '1Y' ? '2025-09-07' : '2025-12-31'),
          );
          const base = points[0]?.twrIndex;
          const history = points
            .filter((_, i) => i % 5 === 0 || i === points.length - 1)
            .map((p) => ({
              date: p.date,
              value: p.valueEUR,
              flow: p.netExternalFlowEUR,
              index:
                base && p.twrIndex !== null ? (p.twrIndex / base) * 100 : null,
            }));
          const report = {
            id: crypto.randomUUID(),
            name: inputString(input.name, 'Portfolio report').slice(0, 100),
            family,
            range: inputString(input.range, 'YTD').slice(0, 20),
            createdAt: now,
            totalValueEUR: positions.reduce((v, h) => v + h.valueEUR, 0),
            holdingCount: positions.length,
            holdings: positions,
            history,
          };
          return { ...s, reports: [report, ...s.reports].slice(0, 40) };
        }
        case 'settings': {
          const name = inputString(input.name).trim();
          if (name.length < 2 || name.length > 80)
            throw new Error('Use 2–80 characters for the workspace name');
          return { ...s, officeName: name };
        }
        case 'reset':
          return initialWorkspace();
        default:
          throw new Error('Unknown workspace action');
      }
    });
    return Response.json(state, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Could not save the change',
      },
      { status: 400 },
    );
  }
}
