import { AsyncLocalStorage } from 'node:async_hooks';
import type { LifecycleMode } from '../lifecycle-contract';
export type LifecycleOperation = { id: string; token: string };
export type LifecycleContext = {
  mode: LifecycleMode;
  readOnly: boolean;
  operation?: LifecycleOperation;
  signal?: AbortSignal;
};
export const lifecycleContext = new AsyncLocalStorage<LifecycleContext>();
export const maintenanceRead = () => {
  const context = lifecycleContext.getStore();
  return !!context?.readOnly && context.mode !== 'open';
};
