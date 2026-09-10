'use client';
import { createContext, useContext } from 'react';
import {
  initialWorkspace,
  deriveWorkspace,
  type WorkspaceState,
} from '@/lib/workspace';
export type WorkspaceContextValue = {
  revision: number;
  state: WorkspaceState;
  data: ReturnType<typeof deriveWorkspace>;
  mutate: (input: Record<string, unknown>) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  reload: () => void;
};
const state = initialWorkspace(false);
export const WorkspaceContext = createContext<WorkspaceContextValue>({
  revision: -1,
  state,
  data: deriveWorkspace(state),
  mutate: async () => false,
  loading: true,
  error: null,
  reload: () => {},
});
export const useWorkspace = () => useContext(WorkspaceContext);
