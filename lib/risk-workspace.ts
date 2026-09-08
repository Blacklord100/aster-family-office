import { z } from 'zod';
import { riskDataSchema, riskScenarioSchema } from './risk-contract';
import { deriveWorkspace, type WorkspaceState } from './workspace';

export const riskActions = [
  z.object({ type: z.literal('riskData'), data: riskDataSchema }).strict(),
  z.object({
    type: z.literal('riskScenario'),
    name: z.string().trim().min(1).max(100),
    scenario: riskScenarioSchema,
  }).strict(),
  z.object({ type: z.literal('riskScenarioDelete'), id: z.uuid() }).strict(),
] as const;
export const riskActionSchema = z.discriminatedUnion('type', riskActions);
export type RiskAction = z.infer<typeof riskActionSchema>;
export class RiskWorkspaceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Templates store assumptions only; valuations and financial records never change. */
export function changeRiskWorkspace(state: WorkspaceState, action: RiskAction): WorkspaceState {
  const input = riskActionSchema.parse(action);
  if (input.type === 'riskData') {
    const holdings = new Set(deriveWorkspace(state).holdings.map((holding) => holding.id));
    if (input.data.positions.some((position) => !holdings.has(position.holdingId)))
      throw new RiskWorkspaceError('INVALID_HOLDING', 'Every mapped holding must belong to this workspace.');
    if (!state.sampleData && [...input.data.nodes, ...input.data.links].some((item) => item.synthetic))
      throw new RiskWorkspaceError('SAMPLE_MAPPING_DISABLED', 'Synthetic relationships can only be saved in a sample workspace.');
    return { ...state, riskData: input.data };
  }
  const templates = state.riskScenarios ?? [];
  if (input.type === 'riskScenarioDelete') {
    if (!templates.some((item) => item.id === input.id))
      throw new RiskWorkspaceError('SCENARIO_NOT_FOUND', 'Scenario template not found.');
    return { ...state, riskScenarios: templates.filter((item) => item.id !== input.id) };
  }
  if (templates.length >= 20)
    throw new RiskWorkspaceError('SCENARIO_LIMIT', 'This workspace has 20 scenario templates. Remove a template before saving another.');
  return {
    ...state,
    riskScenarios: [{ id: crypto.randomUUID(), name: input.name, scenario: input.scenario, createdAt: new Date().toISOString() }, ...templates],
  };
}
