export type DemoWorkspaceState = {
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
