import { describe, expect, it } from 'vitest';
import {
  canonicalWorkspaceView,
  connectionTabFor,
  workspaceViewAvailable,
} from './workspace-navigation';

describe('workspace navigation compatibility', () => {
  it('opens saved engine links in the merged engine settings', () => {
    const params = new URLSearchParams('view=engines&family=meridian');
    expect(canonicalWorkspaceView(params.get('view')!)).toBe('connections');
    expect(connectionTabFor(params)).toBe('engines');
    expect(params.get('family')).toBe('meridian');
  });

  it.each(['connected', 'error'])(
    'shows the mailbox authorization result on its own tab: %s',
    (mailbox) => {
      expect(
        connectionTabFor(
          new URLSearchParams({ view: 'connections', mailbox, tab: 'folders' }),
        ),
      ).toBe('mailboxes');
    },
  );

  it('keeps folder and demo return links on Folders and validates explicit tab links', () => {
    expect(
      connectionTabFor(new URLSearchParams('view=connections&folder=demo')),
    ).toBe('folders');
    expect(
      connectionTabFor(new URLSearchParams('view=connections&tab=engines')),
    ).toBe('engines');
    expect(
      connectionTabFor(new URLSearchParams('view=connections&tab=tools')),
    ).toBe('tools');
    expect(
      connectionTabFor(new URLSearchParams('view=connections&tab=untrusted')),
    ).toBe('folders');
  });

  it('waits for identity before redirecting legacy Inbox into the office pipeline', () => {
    expect(canonicalWorkspaceView('inbox', null)).toBe('inbox');
    expect(canonicalWorkspaceView('inbox', { role: 'viewer' })).toBe('agents');
    expect(workspaceViewAvailable('inbox', { role: 'viewer' })).toBe(false);
    expect(workspaceViewAvailable('agents', { role: 'viewer' })).toBe(true);
  });

  it('preserves the scoped source library without exposing office-wide settings or documents', () => {
    const identity = { role: 'viewer', dataScope: { familyIds: ['meridian'] } };
    expect(canonicalWorkspaceView('inbox', identity)).toBe('inbox');
    expect(workspaceViewAvailable('inbox', identity)).toBe(true);
    for (const view of [
      'agents',
      'engines',
      'connections',
      'intelligence',
      'operations',
    ]) {
      expect(workspaceViewAvailable(view, identity)).toBe(false);
    }
    expect(
      workspaceViewAvailable(
        canonicalWorkspaceView('engines', identity),
        identity,
      ),
    ).toBe(false);
    expect(workspaceViewAvailable('investments', identity)).toBe(true);
  });

  it('retains administrator-only operations visibility', () => {
    expect(workspaceViewAvailable('operations', { role: 'analyst' })).toBe(
      false,
    );
    expect(workspaceViewAvailable('operations', { role: 'admin' })).toBe(true);
  });
});
