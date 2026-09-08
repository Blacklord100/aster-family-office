import { describe, expect, it } from 'vitest';
import { initialWorkspace, deriveWorkspace } from './workspace';
import { changeRiskWorkspace } from './risk-workspace';
import { emptyRiskData, type RiskScenario } from './risk-contract';

const scenario: RiskScenario = { id: 'custom', name: 'Custom', description: 'Hypothetical', assetClassShocks: { 'Public equities': -0.3 }, capitalCallRate: 0.5 };

describe('durable risk assumptions', () => {
  it('saves a reusable scenario without changing financial records and removes only the requested template', () => {
    const initial = initialWorkspace(true);
    const before = deriveWorkspace(initial);
    const first = changeRiskWorkspace(initial, { type: 'riskScenario', name: 'Downturn', scenario });
    const second = changeRiskWorkspace(first, { type: 'riskScenario', name: 'Another', scenario });
    const remaining = changeRiskWorkspace(second, { type: 'riskScenarioDelete', id: first.riskScenarios![0].id });
    expect(deriveWorkspace(remaining)).toEqual(before);
    expect(initial.riskScenarios).toBeUndefined();
    expect(remaining.riskScenarios?.map((row) => row.name)).toEqual(['Another']);
    expect(remaining.riskScenarios![0]).not.toHaveProperty('holdings');
  });
  it('rejects foreign holdings, invalid graph structure, and synthetic mappings in a live workspace', () => {
    const data = { ...emptyRiskData(), nodes: [{ id: 'fund', name: 'Fund', kind: 'fund' as const }], positions: [{ holdingId: 'foreign', nodeId: 'fund' }] };
    expect(() => changeRiskWorkspace(initialWorkspace(false), { type: 'riskData', data })).toThrow(/belong/);
    expect(() => changeRiskWorkspace(initialWorkspace(true), { type: 'riskData', data: { ...data, positions: [], links: [{ id: 'loop', parentId: 'fund', childId: 'fund' }] } })).toThrow(/cycle/);
    expect(() => changeRiskWorkspace(initialWorkspace(false), { type: 'riskData', data: { ...data, positions: [], nodes: [{ ...data.nodes[0], synthetic: true }] } })).toThrow(/Synthetic/);
  });
  it('preserves existing assumptions on missing deletion and capacity failures', () => {
    let state = initialWorkspace(false);
    for (let i = 0; i < 20; i++) state = changeRiskWorkspace(state, { type: 'riskScenario', name: `Scenario ${i}`, scenario });
    expect(() => changeRiskWorkspace(state, { type: 'riskScenario', name: 'Excess', scenario })).toThrow(/20/);
    expect(() => changeRiskWorkspace(state, { type: 'riskScenarioDelete', id: crypto.randomUUID() })).toThrow(/not found/);
    expect(state.riskScenarios).toHaveLength(20);
  });
  it('rejects nonfinite shocks and out-of-bound capital-call assumptions', () => {
    for (const invalid of [{ ...scenario, capitalCallRate: 1.1 }, { ...scenario, assetClassShocks: { 'Public equities': NaN } }, { ...scenario, assetClassShocks: { 'Public equities': -1.01 } }])
      expect(() => changeRiskWorkspace(initialWorkspace(), { type: 'riskScenario', name: 'Invalid', scenario: invalid })).toThrow();
  });
});
