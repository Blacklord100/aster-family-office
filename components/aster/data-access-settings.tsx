'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DataScope } from '@/lib/data-scope';
import {
  useWorkspaceRequest,
  WorkspaceRequestError,
} from './use-workspace-request';
type AccessData = {
  members: {
    id: string;
    name: string;
    role: string;
    scope: DataScope | null;
  }[];
  families: { id: string; name: string }[];
  entities: { id: string; name: string; familyId: string }[];
  documents: {
    id: string;
    filename: string;
    familyIds: string[] | null;
    entityIds: string[] | null;
  }[];
  documentLimit: number;
};
export function DataAccessSettings() {
  const { key } = useWorkspaceRequest();
  return <ScopedDataAccessSettings key={key} />;
}
function ScopedDataAccessSettings() {
  const { request } = useWorkspaceRequest();
  const [data, setData] = useState<AccessData | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [kind, setKind] = useState<'member' | 'document'>('member'),
    [target, setTarget] = useState(''),
    [familyIds, setFamilies] = useState<string[]>([]),
    [entityIds, setEntities] = useState<string[]>([]),
    [restricted, setRestricted] = useState(true),
    [verified, setVerified] = useState(false);
  async function load() {
    try {
      setData(await request<AccessData>('/api/data-access'));
      setError('');
    } catch (e) {
      if (e instanceof WorkspaceRequestError && [401, 403].includes(e.status)) {
        setData(null);
        setTarget('');
        setVerified(false);
      }
      setError(e instanceof Error ? e.message : 'Could not load access');
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void request<AccessData>('/api/data-access', { signal: controller.signal })
      .then(setData)
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Could not load access');
      });
    return () => controller.abort();
  }, [request]);
  function select(id: string, nextKind = kind) {
    setTarget(id);
    setVerified(false);
    const row = data?.members.find((m) => m.id === id),
      doc = data?.documents.find((d) => d.id === id);
    const scope =
      nextKind === 'member'
        ? row?.scope
        : doc?.familyIds
          ? { familyIds: doc.familyIds, entityIds: doc.entityIds ?? [] }
          : null;
    setRestricted(!!scope);
    setFamilies(scope?.familyIds ?? []);
    setEntities(scope?.entityIds ?? []);
  }
  async function save() {
    if (!data || !target) return;
    setBusy(true);
    setError('');
    try {
      const scope = restricted ? { familyIds, entityIds } : null;
      const body =
        kind === 'member'
          ? {
              action: kind,
              userId: target,
              scope,
              expectedScope:
                data.members.find((m) => m.id === target)?.scope ?? null,
            }
          : {
              action: kind,
              documentId: target,
              scope,
              evidenceVerified: verified,
            };
      await request('/api/data-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await load();
      setVerified(false);
    } catch (e) {
      if (e instanceof WorkspaceRequestError && [401, 403].includes(e.status)) {
        setData(null);
        setTarget('');
        setVerified(false);
      }
      setError(e instanceof Error ? e.message : 'Could not update access');
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <p className="text-sm" role={error ? 'alert' : undefined}>
        {error || 'Loading client access…'}
        {error ? (
          <Button variant="link" size="sm" onClick={() => void load()}>
            Reload access
          </Button>
        ) : null}
      </p>
    );
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Family & entity access
      </summary>
      <div className="mt-4 space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Client access is read only. Family filters also apply to reports,
          balances and answers. Originals require a separate review of the
          entire document.
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={kind === 'member' ? 'default' : 'outline'}
            onClick={() => {
              setKind('member');
              select('', 'member');
            }}
          >
            Viewer permissions
          </Button>
          <Button
            size="sm"
            variant={kind === 'document' ? 'default' : 'outline'}
            onClick={() => {
              setKind('document');
              select('', 'document');
            }}
          >
            Release originals
          </Button>
        </div>
        <select
          aria-label={
            kind === 'member' ? 'Client viewer' : 'Original to release'
          }
          className="w-full rounded border bg-background p-2"
          value={target}
          onChange={(e) => select(e.target.value)}
        >
          <option value="">
            Choose {kind === 'member' ? 'a viewer' : 'an original'}
          </option>
          {kind === 'member'
            ? data.members
                .filter((m) => m.role === 'viewer')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))
            : data.documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.filename}
                </option>
              ))}
        </select>
        {target ? (
          <>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={restricted}
                onChange={(e) => {
                  setRestricted(e.target.checked);
                  setVerified(false);
                }}
              />
              {kind === 'member'
                ? 'Limit this viewer to selected families'
                : 'Release this document to matching client viewers'}
            </label>
            {!restricted ? (
              <p className="text-xs text-muted-foreground">
                {kind === 'member'
                  ? 'This viewer can read the whole workspace.'
                  : 'This original remains available only to unrestricted office members.'}
              </p>
            ) : (
              <>
                <fieldset className="space-y-1">
                  <legend className="font-medium">Families</legend>
                  {data.families.map((f) => (
                    <label key={f.id} className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={familyIds.includes(f.id)}
                        onChange={(e) => {
                          setVerified(false);
                          setFamilies((prev) =>
                            e.target.checked
                              ? [...prev, f.id]
                              : prev.filter((id) => id !== f.id),
                          );
                          setEntities([]);
                        }}
                      />
                      {f.name}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="space-y-1">
                  <legend className="font-medium">Entities</legend>
                  <p className="text-xs text-muted-foreground">
                    Leave unchecked for every entity in the selected families.
                  </p>
                  {data.entities
                    .filter((e) => familyIds.includes(e.familyId))
                    .map((entity) => (
                      <label key={entity.id} className="flex gap-2">
                        <input
                          type="checkbox"
                          checked={entityIds.includes(entity.id)}
                          onChange={(e) => {
                            setVerified(false);
                            setEntities((prev) =>
                              e.target.checked
                                ? [...prev, entity.id]
                                : prev.filter((id) => id !== entity.id),
                            );
                          }}
                        />
                        {entity.name}
                      </label>
                    ))}
                </fieldset>
              </>
            )}
            {kind === 'document' ? (
              <>
                <Button
                  variant="link"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      const original = await request<Blob>(
                        '/api/documents/' + encodeURIComponent(target),
                        {},
                        'blob',
                      );
                      const url = URL.createObjectURL(original);
                      const anchor = document.createElement('a');
                      anchor.href = url;
                      anchor.download =
                        data.documents.find(
                          (document) => document.id === target,
                        )?.filename ?? 'source-original';
                      anchor.click();
                      URL.revokeObjectURL(url);
                    } catch (error) {
                      if (
                        error instanceof WorkspaceRequestError &&
                        [401, 403].includes(error.status)
                      ) {
                        setData(null);
                        setTarget('');
                        setVerified(false);
                      }
                      setError(
                        error instanceof Error
                          ? error.message
                          : 'The original could not be downloaded.',
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Download original before release
                </Button>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={verified}
                    onChange={(e) => setVerified(e.target.checked)}
                  />
                  I reviewed the entire original. Every family and entity whose
                  information it contains is selected above.
                </label>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Saving revokes this viewer’s current sessions. Promoting a
                viewer to an analyst or administrator restores workspace-wide
                access.
              </p>
            )}
            <Button
              disabled={
                busy ||
                (restricted && !familyIds.length) ||
                (kind === 'document' && !verified)
              }
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save access'}
            </Button>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
