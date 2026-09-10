export const DEMO_DATASETS = ['mailroom-v1', 'history-v1'] as const;
export type DemoDataset = (typeof DEMO_DATASETS)[number];
export type DemoWorkspaceState = {
  /** Older retained demonstrations use mailroom-v1. Pinned at creation. */
  dataset?: DemoDataset;
  runId: string;
  name: string;
  startedAt: string;
  sourceFiles: number;
  autoPublish: true;
  /** Demonstration assumptions, never live market rates. */
  fxPolicy: { source: string; ratesToEUR: Record<string, string> };
};
export type DemoRun = Omit<DemoWorkspaceState, 'autoPublish' | 'fxPolicy'> & {
  organizationId: string;
};
export type DemoResponse = {
  enabled: boolean;
  canCreate: boolean;
  current: DemoRun | null;
  runs: DemoRun[];
};
