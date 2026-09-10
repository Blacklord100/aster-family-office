export const connectionTabs = [
  'mailboxes',
  'folders',
  'engines',
  'tools',
] as const;
export type ConnectionTab = (typeof connectionTabs)[number];
type NavigationIdentity = { role: string; dataScope?: unknown };

export function canonicalWorkspaceView(
  view: string,
  identity?: NavigationIdentity | null,
): string {
  if (view === 'engines') return 'connections';
  // Until identity loads, do not turn a scoped source-library link into an
  // office-wide document API request. The server still enforces every scope.
  if (view === 'inbox' && identity && !identity.dataScope) return 'agents';
  return view;
}

export function workspaceViewAvailable(
  view: string,
  identity?: NavigationIdentity | null,
): boolean {
  if (view === 'inbox') return Boolean(identity?.dataScope);
  if (
    view === 'operations' &&
    !['owner', 'admin'].includes(identity?.role ?? '')
  )
    return false;
  return (
    !identity?.dataScope ||
    ![
      'agents',
      'engines',
      'connections',
      'intelligence',
      'operations',
    ].includes(view)
  );
}

export function isConnectionTab(value: unknown): value is ConnectionTab {
  return connectionTabs.some((tab) => tab === value);
}

/** Keep saved engine links and provider/folder return paths in the same workspace. */
export function connectionTabFor(params: URLSearchParams): ConnectionTab {
  if (params.get('view') === 'engines') return 'engines';
  if (params.has('mailbox')) return 'mailboxes';
  const tab = params.get('tab');
  return isConnectionTab(tab) ? tab : 'folders';
}
