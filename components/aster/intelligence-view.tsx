'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Search,
  RefreshCw,
  FileText,
  Plus,
  Check,
  Pencil,
  Trash2,
  Network,
  Users,
  PenLine,
  ArrowUpRight,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  IntelligenceResponse,
  IntelligenceCommand,
  RelationshipRecord,
  ProspectiveDeal,
  FollowupDraft,
  SearchResponse,
  IssuerAlias,
} from '@/lib/intelligence-contract';
import { buildTotalExposure } from '@/lib/risk-engine';
import { emptyRiskData } from '@/lib/risk-contract';
import { PageHeading, Picker, money, dateLabel as date } from './primitives';
import { useWorkspace } from './workspace-context';
import styles from './intelligence.module.css';
type Collection = 'managers' | 'contacts' | 'mandates';
const titles: Record<Collection, string> = {
  managers: 'Managers',
  contacts: 'Contacts',
  mandates: 'Mandates',
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    ...(body
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.message ?? 'Request failed.');
  return value;
}
const blankRecord = (): RelationshipRecord => ({
  id: crypto.randomUUID(),
  name: '',
  familyId: null,
  holdingId: null,
  managerId: null,
  email: '',
  notes: '',
  updatedAt: new Date().toISOString(),
});
function Blank({ title, description }: { title: string; description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
export function IntelligenceView({ family = 'all' }: { family?: string }) {
  const workspace = useWorkspace();
  const [snapshot, setSnapshot] = useState<IntelligenceResponse | null>(null),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState<string | null>('load');
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<SearchResponse | null>(null),
    [documentId, setDocumentId] = useState(''),
    [holdingId, setHoldingId] = useState('');
  const [collection, setCollection] = useState<Collection>('managers'),
    [record, setRecord] = useState<RelationshipRecord | null>(null),
    [deal, setDeal] = useState<ProspectiveDeal | null>(null),
    [draft, setDraft] = useState<FollowupDraft | null>(null),
    [alias, setAlias] = useState<IssuerAlias | null>(null),
    [aliasText, setAliasText] = useState(''),
    [canonical, setCanonical] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    setSnapshot(await api<IntelligenceResponse>('/api/intelligence'));
  }, []);
  useEffect(() => {
    let alive = true;
    api<IntelligenceResponse>('/api/intelligence')
      .then((value) => {
        if (alive) setSnapshot(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  const run = async (label: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(null);
    }
  };
  const save = async (command: IntelligenceCommand) => {
    await api('/api/intelligence', command);
    await load();
    workspace.reload();
    setNotice('Saved in this workspace.');
  };
  const holdings = workspace.data.holdings.filter(
    (h) => family === 'all' || h.familyId === family,
  );
  const exposure = useMemo(() => {
    try {
      return buildTotalExposure(
        holdings,
        workspace.state.riskData ?? emptyRiskData(),
      );
    } catch {
      return null;
    }
  }, [holdings, workspace.state.riskData]);
  const familyOptions = [
    { value: 'none', label: 'Office-wide / unassigned' },
    ...workspace.data.families.map((f) => ({ value: f.id, label: f.name })),
  ];
  const holdingOptions = [
    { value: 'none', label: 'No linked holding' },
    ...holdings.map((h) => ({ value: h.id, label: h.name })),
  ];
  const state = snapshot?.state;
  const managerOptions = [
    { value: 'none', label: 'No linked manager' },
    ...(state?.managers ?? []).map((m) => ({ value: m.id, label: m.name })),
  ];
  const recordFamily = (
    value: RelationshipRecord | ProspectiveDeal,
    set: (value: RelationshipRecord) => void,
  ) => (
    <>
      <Field>
        <FieldLabel>Family</FieldLabel>
        <Picker
          label="Record family"
          value={value.familyId ?? 'none'}
          onChange={(id) =>
            set({
              ...value,
              familyId: id === 'none' ? null : id,
              holdingId: null,
            })
          }
          options={familyOptions}
        />
      </Field>
      <Field>
        <FieldLabel>Linked holding</FieldLabel>
        <Picker
          label="Record holding"
          value={value.holdingId ?? 'none'}
          onChange={(id) =>
            set({
              ...value,
              holdingId: id === 'none' ? null : id,
              ...(id === 'none'
                ? {}
                : {
                    familyId:
                      holdings.find((h) => h.id === id)?.familyId ?? null,
                  }),
            })
          }
          options={holdingOptions}
        />
      </Field>
    </>
  );
  return (
    <div className={styles.page}>
      <PageHeading
        title="Intelligence"
        subtitle="Connect source evidence, issuer identities and the people behind your investments."
      >
        <Button
          variant="outline"
          disabled={!!busy}
          onClick={() => run('refresh', load)}
        >
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
      </PageHeading>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Unable to complete this action</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <Check />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {!snapshot ? (
        busy ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <Blank
            title="Intelligence is unavailable"
            description="Office-wide access is needed for the library and relationship records. Scoped members can use Ask Aster with released sources."
          />
        )
      ) : (
        <>
          <div className={styles.summary}>
            <div>
              <BookOpen />
              <span>Indexed sources</span>
              <strong>
                {snapshot.documents.filter((d) => d.indexed).length}
                <small>
                  {' '}
                  / {snapshot.documents.length}
                  {snapshot.documentListTruncated ? '+' : ''} recent
                </small>
              </strong>
            </div>
            <div>
              <Network />
              <span>Awaiting review</span>
              <strong>
                {state!.proposals.filter((p) => p.status === 'pending').length}
              </strong>
            </div>
            <div>
              <Users />
              <span>Relationships</span>
              <strong>{state!.managers.length + state!.contacts.length}</strong>
            </div>
            <div>
              <PenLine />
              <span>Saved drafts</span>
              <strong>{state!.drafts.length}</strong>
            </div>
          </div>
          <Tabs defaultValue="sources">
            <div className={styles.tabScroll}>
              <TabsList variant="line">
                <TabsTrigger value="sources">Source library</TabsTrigger>
                <TabsTrigger value="proposals">Constituents</TabsTrigger>
                <TabsTrigger value="relationships">Relationships</TabsTrigger>
                <TabsTrigger value="deals">Deals & overlap</TabsTrigger>
                <TabsTrigger value="drafts">Follow-ups</TabsTrigger>
                <TabsTrigger value="issuers">Issuer identities</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="sources">
              <div className={styles.columns}>
                <section className={styles.panel}>
                  <h2>Search the evidence</h2>
                  <p className={styles.muted}>
                    Decoded text stays encrypted in your workspace. Search
                    includes indexed originals only.
                  </p>
                  <form
                    className={styles.search}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run('search', async () => {
                        setResults(
                          await api<SearchResponse>(
                            '/api/intelligence/search?q=' +
                              encodeURIComponent(query),
                          ),
                        );
                      });
                    }}
                  >
                    <Field>
                      <FieldLabel
                        className="sr-only"
                        htmlFor="intelligence-query"
                      >
                        Search documents
                      </FieldLabel>
                      <Input
                        id="intelligence-query"
                        placeholder="Company, manager, mandate or phrase…"
                        value={query}
                        maxLength={600}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </Field>
                    <Button
                      type="submit"
                      disabled={!!busy || query.trim().length < 2}
                    >
                      <Search data-icon="inline-start" />
                      Search
                    </Button>
                  </form>
                  {results ? (
                    <>
                      <p className={styles.muted}>
                        {results.coverage.searchedDocuments} indexed documents ·{' '}
                        {results.coverage.searchedPages} pages searched ·{' '}
                        {results.coverage.scannedCharacters.toLocaleString()}{' '}
                        characters
                        {results.coverage.truncated ? ' · Coverage capped' : ''}
                      </p>
                      {results.coverage.warnings.map((w, i) => (
                        <p className={styles.muted} key={i}>
                          {w}
                        </p>
                      ))}
                      {results.hits.length ? (
                        results.hits.map((h) => (
                          <article className={styles.source} key={h.id}>
                            <a
                              href={'/api/documents/' + h.documentId}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <FileText />
                              {h.filename}
                              <ArrowUpRight />
                            </a>
                            <span>
                              {h.source} · page {h.page}
                            </span>
                            <blockquote>{h.quote}</blockquote>
                          </article>
                        ))
                      ) : (
                        <Blank
                          title="No matching indexed text"
                          description="Index another source or search with a different term. This does not prove the information is absent from your originals."
                        />
                      )}
                    </>
                  ) : (
                    <Blank
                      title="Your evidence, searchable"
                      description="Index a PDF, email or text original, then find exact passages with page and attachment references."
                    />
                  )}
                </section>
                <aside className={styles.panel}>
                  <h2>Original documents</h2>
                  <p className={styles.muted}>
                    Upload in Documents, then index here. OCR and skipped-page
                    warnings remain visible.
                  </p>
                  {snapshot.documentListTruncated ? (
                    <p className={styles.muted}>
                      Showing the newest 100 originals.
                    </p>
                  ) : null}
                  {snapshot.documents.length ? (
                    snapshot.documents.map((d) => (
                      <div className={styles.document} key={d.id}>
                        <div>
                          <a
                            href={'/api/documents/' + d.id}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {d.filename}
                          </a>
                          <span>
                            {d.indexed
                              ? `${d.pageCount} decoded pages`
                              : 'Not indexed'}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!!busy || !snapshot.canWrite}
                          onClick={() =>
                            void run(d.id, async () => {
                              const result = await api<{
                                warnings: string[];
                                pages: number;
                              }>('/api/intelligence/index', {
                                documentId: d.id,
                              });
                              await load();
                              setNotice(
                                `${result.pages} pages indexed. ${result.warnings.join(' ') || 'Original page boundaries preserved.'}`,
                              );
                            })
                          }
                        >
                          {busy === d.id ? (
                            <Loader2 data-icon="inline-start" />
                          ) : null}
                          {d.indexed ? 'Re-index' : 'Index'}
                        </Button>
                      </div>
                    ))
                  ) : (
                    <Blank
                      title="No originals yet"
                      description="Upload an investment PDF, email or text file in Documents."
                    />
                  )}
                </aside>
              </div>
            </TabsContent>
            <TabsContent value="proposals">
              <section className={styles.panel}>
                <h2>Constituent review</h2>
                <p className={styles.muted}>
                  Extract explicit company and weight rows from a source table.
                  Administrators approve each mapping; missing weights and dates
                  stay unknown. Narrative or ambiguous layouts may yield no
                  proposals.
                </p>
                <FieldGroup className={styles.formGrid}>
                  <Field>
                    <FieldLabel>Indexed original</FieldLabel>
                    <Picker
                      label="Constituent original"
                      value={documentId || 'none'}
                      onChange={(id) => setDocumentId(id === 'none' ? '' : id)}
                      options={[
                        { value: 'none', label: 'Choose an indexed source' },
                        ...snapshot.documents
                          .filter((d) => d.indexed)
                          .map((d) => ({ value: d.id, label: d.filename })),
                      ]}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Parent fund holding</FieldLabel>
                    <Picker
                      label="Constituent parent holding"
                      value={holdingId || 'none'}
                      onChange={(id) => setHoldingId(id === 'none' ? '' : id)}
                      options={[
                        { value: 'none', label: 'Choose an existing holding' },
                        ...holdings.map((h) => ({
                          value: h.id,
                          label: h.name,
                        })),
                      ]}
                    />
                  </Field>
                  <Button
                    disabled={
                      !snapshot.canWrite || !!busy || !documentId || !holdingId
                    }
                    onClick={() =>
                      void run('propose', async () => {
                        const before = state!.proposals.length;
                        await save({
                          action: 'propose',
                          documentId,
                          holdingId,
                        });
                        setNotice(
                          `Source checked. Review any new proposals below; supported table rows only. Existing proposals (${before}) are not duplicated.`,
                        );
                      })
                    }
                  >
                    Extract proposals
                  </Button>
                </FieldGroup>
              </section>
              <div className={styles.cards}>
                {state!.proposals.length ? (
                  [...state!.proposals].reverse().map((p) => (
                    <article className={styles.panel} key={p.id}>
                      <div className={styles.row}>
                        <div>
                          <h3>{p.issuerName}</h3>
                          <p className={styles.muted}>
                            {workspace.data.holdings.find(
                              (h) => h.id === p.holdingId,
                            )?.name ?? 'Holding unavailable'}
                          </p>
                        </div>
                        <Badge
                          variant={
                            p.status === 'pending' ? 'secondary' : 'outline'
                          }
                        >
                          {p.status}
                        </Badge>
                      </div>
                      <div className={styles.facts}>
                        <div>
                          <span>Portfolio weight</span>
                          <strong>
                            {p.weight === null
                              ? 'Undisclosed'
                              : `${(p.weight * 100).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`}
                          </strong>
                        </div>
                        <div>
                          <span>Source date</span>
                          <strong>
                            {p.asOfDate
                              ? date(p.asOfDate)
                              : 'Not stated in quote'}
                          </strong>
                        </div>
                      </div>
                      <blockquote className={styles.quote}>
                        {p.citation.quote}
                      </blockquote>
                      <a
                        className={styles.sourceLink}
                        href={'/api/documents/' + p.citation.documentId}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Original · {p.citation.source} · page {p.citation.page}
                        <ArrowUpRight />
                      </a>
                      {p.status === 'pending' && snapshot.canReview ? (
                        <div className={styles.review}>
                          <Field>
                            <FieldLabel>Canonical issuer</FieldLabel>
                            <Picker
                              label={'Canonical issuer for ' + p.issuerName}
                              value={canonical[p.id] ?? p.issuerId ?? 'new'}
                              options={[
                                {
                                  value: 'new',
                                  label: 'Create issuer from reported name',
                                },
                                ...state!.aliases.map((a) => ({
                                  value: a.id,
                                  label: a.name,
                                })),
                              ]}
                              onChange={(id) =>
                                setCanonical((v) => ({ ...v, [p.id]: id }))
                              }
                            />
                          </Field>
                          <p className={styles.muted}>
                            Accepting adds one source-linked risk mapping. It
                            does not change NAV. Review issuer identity and the
                            source before accepting.
                          </p>
                          <div className={styles.actions}>
                            <Button
                              disabled={!!busy}
                              onClick={() =>
                                void run(p.id, () =>
                                  save({
                                    action: 'review',
                                    proposalId: p.id,
                                    decision: 'accept',
                                    ...((canonical[p.id] ?? p.issuerId) &&
                                    canonical[p.id] !== 'new'
                                      ? {
                                          issuerId:
                                            canonical[p.id] ?? p.issuerId!,
                                        }
                                      : {}),
                                  }),
                                )
                              }
                            >
                              Accept into risk
                            </Button>
                            <Button
                              variant="outline"
                              disabled={!!busy}
                              onClick={() =>
                                void run(p.id, () =>
                                  save({
                                    action: 'review',
                                    proposalId: p.id,
                                    decision: 'reject',
                                  }),
                                )
                              }
                            >
                              Reject
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  ))
                ) : (
                  <Blank
                    title="No constituent proposals"
                    description="Choose an indexed disclosure and its parent holding. Supported rows retain their exact source text for review."
                  />
                )}
              </div>
            </TabsContent>
            <TabsContent value="relationships">
              <div className={styles.row}>
                <Picker
                  label="Relationship category"
                  value={collection}
                  onChange={(value) => {
                    setCollection(value as Collection);
                    setRecord(null);
                  }}
                  options={Object.entries(titles).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
                <Button
                  disabled={!snapshot.canWrite || !!busy}
                  onClick={() => setRecord(blankRecord())}
                >
                  <Plus data-icon="inline-start" />
                  Add{' '}
                  {collection === 'managers'
                    ? 'manager'
                    : collection === 'contacts'
                      ? 'contact'
                      : 'mandate'}
                </Button>
              </div>
              <div className={styles.columns}>
                <section className={styles.panel}>
                  <h2>{titles[collection]}</h2>
                  {state![collection].length ? (
                    state![collection].map((r) => (
                      <article className={styles.record} key={r.id}>
                        <div className={styles.row}>
                          <h3>{r.name}</h3>
                          {snapshot.canWrite ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setRecord(r)}
                              aria-label={'Edit ' + r.name}
                            >
                              <Pencil />
                            </Button>
                          ) : null}
                        </div>
                        <p>{r.email}</p>
                        <p className={styles.muted}>
                          {r.managerId
                            ? state!.managers.find((m) => m.id === r.managerId)
                                ?.name
                            : ''}
                          {r.holdingId
                            ? ' · ' +
                              workspace.data.holdings.find(
                                (h) => h.id === r.holdingId,
                              )?.name
                            : ''}
                        </p>
                        <p className={styles.notes}>
                          {r.notes || 'No notes yet.'}
                        </p>
                      </article>
                    ))
                  ) : (
                    <Blank
                      title={'No ' + collection + ' recorded'}
                      description="Keep manager context, relationship contacts and mandate notes with explicit links to the relevant family or holding."
                    />
                  )}
                </section>
                {record ? (
                  <aside className={styles.panel}>
                    <h2>
                      {state![collection].some((r) => r.id === record.id)
                        ? 'Edit'
                        : 'New'}{' '}
                      {collection.slice(0, -1)}
                    </h2>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run('record', async () => {
                          await save({
                            action: 'record',
                            collection,
                            value: record,
                          });
                          setRecord(null);
                        });
                      }}
                    >
                      <FieldGroup>
                        <Field>
                          <FieldLabel htmlFor="relationship-name">
                            Name
                          </FieldLabel>
                          <Input
                            id="relationship-name"
                            required
                            maxLength={240}
                            value={record.name}
                            onChange={(e) =>
                              setRecord({ ...record, name: e.target.value })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="relationship-email">
                            Email (optional)
                          </FieldLabel>
                          <Input
                            id="relationship-email"
                            type="email"
                            maxLength={240}
                            value={record.email}
                            onChange={(e) =>
                              setRecord({ ...record, email: e.target.value })
                            }
                          />
                        </Field>
                        {collection !== 'managers' ? (
                          <Field>
                            <FieldLabel>Manager</FieldLabel>
                            <Picker
                              label="Linked manager"
                              value={record.managerId ?? 'none'}
                              options={managerOptions}
                              onChange={(id) =>
                                setRecord({
                                  ...record,
                                  managerId: id === 'none' ? null : id,
                                })
                              }
                            />
                          </Field>
                        ) : null}
                        {recordFamily(record, setRecord)}
                        <Field>
                          <FieldLabel htmlFor="relationship-notes">
                            Notes / mandate details
                          </FieldLabel>
                          <Textarea
                            id="relationship-notes"
                            maxLength={3000}
                            value={record.notes}
                            onChange={(e) =>
                              setRecord({ ...record, notes: e.target.value })
                            }
                          />
                        </Field>
                        <div className={styles.actions}>
                          <Button type="submit" disabled={!!busy}>
                            Save record
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setRecord(null)}
                          >
                            Cancel
                          </Button>
                          {state![collection].some(
                            (r) => r.id === record.id,
                          ) ? (
                            <Button
                              type="button"
                              variant="ghost"
                              disabled={!!busy}
                              onClick={() =>
                                void run('delete', async () => {
                                  await save({
                                    action: 'delete',
                                    collection,
                                    id: record.id,
                                  });
                                  setRecord(null);
                                })
                              }
                            >
                              <Trash2 />
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      </FieldGroup>
                    </form>
                  </aside>
                ) : null}
              </div>
            </TabsContent>
            <TabsContent value="deals">
              <div className={styles.row}>
                <p className={styles.muted}>
                  Compare known issuer identities with the current portfolio.
                  Unknown underlying allocations are outside the overlap
                  calculation.
                </p>
                <Button
                  disabled={!snapshot.canWrite || !!busy}
                  onClick={() =>
                    setDeal({
                      ...blankRecord(),
                      stage: 'Watching',
                      issuerIds: [],
                      targetEUR: null,
                    })
                  }
                >
                  <Plus data-icon="inline-start" />
                  Add deal
                </Button>
              </div>
              <div className={styles.columns}>
                <section className={styles.panel}>
                  <h2>Prospective investments</h2>
                  {state!.deals.length ? (
                    state!.deals.map((d) => (
                      <article className={styles.record} key={d.id}>
                        <div className={styles.row}>
                          <h3>{d.name}</h3>
                          <Badge variant="outline">{d.stage}</Badge>
                          {snapshot.canWrite ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={'Edit ' + d.name}
                              onClick={() => setDeal(d)}
                            >
                              <Pencil />
                            </Button>
                          ) : null}
                        </div>
                        <p className={styles.notes}>{d.notes}</p>
                        <p className={styles.muted}>
                          Target:{' '}
                          {d.targetEUR === null
                            ? 'Not specified'
                            : money(d.targetEUR, 2)}
                        </p>
                        {d.issuerIds.length ? (
                          d.issuerIds.map((id) => {
                            const match = exposure?.issuerExposure.find(
                              (e) => e.id === id,
                            );
                            return (
                              <div className={styles.overlap} key={id}>
                                <span>
                                  {state!.aliases.find((a) => a.id === id)
                                    ?.name ?? 'Unknown issuer'}
                                </span>
                                <strong>
                                  {match
                                    ? `${money(match.valueEUR, 2)} · ${match.holdingCount} holdings`
                                    : 'No disclosed overlap'}
                                </strong>
                              </div>
                            );
                          })
                        ) : (
                          <p className={styles.muted}>
                            No canonical issuers linked; overlap unknown.
                          </p>
                        )}
                      </article>
                    ))
                  ) : (
                    <Blank
                      title="A place for prospective deals"
                      description="Record the opportunity, manager and known issuer identities before it becomes a holding."
                    />
                  )}
                </section>
                {deal ? (
                  <aside className={styles.panel}>
                    <h2>Deal details</h2>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run('deal', async () => {
                          await save({ action: 'deal', value: deal });
                          setDeal(null);
                        });
                      }}
                    >
                      <FieldGroup>
                        <Field>
                          <FieldLabel htmlFor="deal-name">
                            Opportunity
                          </FieldLabel>
                          <Input
                            id="deal-name"
                            required
                            maxLength={240}
                            value={deal.name}
                            onChange={(e) =>
                              setDeal({ ...deal, name: e.target.value })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel>Stage</FieldLabel>
                          <Picker
                            label="Deal stage"
                            value={deal.stage}
                            options={[
                              'Watching',
                              'Diligence',
                              'Decision',
                              'Passed',
                            ].map((value) => ({ value, label: value }))}
                            onChange={(value) =>
                              setDeal({
                                ...deal,
                                stage: value as ProspectiveDeal['stage'],
                              })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel>Manager</FieldLabel>
                          <Picker
                            label="Deal manager"
                            options={managerOptions}
                            value={deal.managerId ?? 'none'}
                            onChange={(id) =>
                              setDeal({
                                ...deal,
                                managerId: id === 'none' ? null : id,
                              })
                            }
                          />
                        </Field>
                        {recordFamily(deal, (value) =>
                          setDeal({ ...deal, ...value }),
                        )}
                        <Field>
                          <FieldLabel htmlFor="deal-target">
                            Indicative target (EUR, optional)
                          </FieldLabel>
                          <Input
                            id="deal-target"
                            type="number"
                            min="0"
                            max="1000000000000"
                            step="0.01"
                            value={deal.targetEUR ?? ''}
                            onChange={(e) =>
                              setDeal({
                                ...deal,
                                targetEUR:
                                  e.target.value === ''
                                    ? null
                                    : Number(e.target.value),
                              })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel>Link an issuer</FieldLabel>
                          <Picker
                            label="Add deal issuer"
                            value="none"
                            options={[
                              {
                                value: 'none',
                                label: 'Choose a canonical issuer',
                              },
                              ...state!.aliases
                                .filter((a) => !deal.issuerIds.includes(a.id))
                                .map((a) => ({ value: a.id, label: a.name })),
                            ]}
                            onChange={(id) => {
                              if (id !== 'none')
                                setDeal({
                                  ...deal,
                                  issuerIds: [...deal.issuerIds, id],
                                });
                            }}
                          />
                          {deal.issuerIds.map((id) => (
                            <Button
                              key={id}
                              variant="outline"
                              size="sm"
                              type="button"
                              onClick={() =>
                                setDeal({
                                  ...deal,
                                  issuerIds: deal.issuerIds.filter(
                                    (i) => i !== id,
                                  ),
                                })
                              }
                            >
                              {state!.aliases.find((a) => a.id === id)?.name} ·
                              remove
                            </Button>
                          ))}
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="deal-notes">
                            Thesis / diligence notes
                          </FieldLabel>
                          <Textarea
                            id="deal-notes"
                            maxLength={3000}
                            value={deal.notes}
                            onChange={(e) =>
                              setDeal({ ...deal, notes: e.target.value })
                            }
                          />
                        </Field>
                        <div className={styles.actions}>
                          <Button type="submit" disabled={!!busy}>
                            Save deal
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setDeal(null)}
                          >
                            Cancel
                          </Button>
                          {state!.deals.some((d) => d.id === deal.id) ? (
                            <Button
                              type="button"
                              variant="ghost"
                              disabled={!!busy}
                              onClick={() =>
                                void run('delete', async () => {
                                  await save({
                                    action: 'delete',
                                    collection: 'deals',
                                    id: deal.id,
                                  });
                                  setDeal(null);
                                })
                              }
                            >
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      </FieldGroup>
                    </form>
                  </aside>
                ) : null}
              </div>
            </TabsContent>
            <TabsContent value="drafts">
              <div className={styles.row}>
                <p className={styles.muted}>
                  Private workspace drafts for review. Aster does not send these
                  messages.
                </p>
                <Button
                  disabled={!snapshot.canWrite || !!busy}
                  onClick={() =>
                    setDraft({
                      id: crypto.randomUUID(),
                      contactId: null,
                      familyId: null,
                      holdingId: null,
                      subject: 'Request for current investment information',
                      body: 'Hello,\n\nCould you share the latest investment update, including dated portfolio-company weights where available?\n\nThank you.',
                      status: 'draft',
                      updatedAt: new Date().toISOString(),
                    })
                  }
                >
                  <Plus data-icon="inline-start" />
                  Compose draft
                </Button>
              </div>
              <div className={styles.columns}>
                <section className={styles.panel}>
                  <h2>Saved follow-ups</h2>
                  {state!.drafts.length ? (
                    state!.drafts.map((d) => (
                      <article className={styles.record} key={d.id}>
                        <div className={styles.row}>
                          <h3>{d.subject}</h3>
                          <Badge variant="outline">Draft only</Badge>
                          {snapshot.canWrite ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={'Edit ' + d.subject}
                              onClick={() => setDraft(d)}
                            >
                              <Pencil />
                            </Button>
                          ) : null}
                        </div>
                        <p className={styles.muted}>
                          {d.contactId
                            ? state!.contacts.find((c) => c.id === d.contactId)
                                ?.name
                            : 'No contact assigned'}
                        </p>
                        <p className={styles.notes}>{d.body}</p>
                      </article>
                    ))
                  ) : (
                    <Blank
                      title="Follow-ups, ready for review"
                      description="Save a request for a manager update, ownership breakdown or diligence detail. Nothing is sent from this screen."
                    />
                  )}
                </section>
                {draft ? (
                  <aside className={styles.panel}>
                    <h2>Draft follow-up</h2>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run('draft', async () => {
                          await save({ action: 'draft', value: draft });
                          setDraft(null);
                        });
                      }}
                    >
                      <FieldGroup>
                        <Field>
                          <FieldLabel>Contact</FieldLabel>
                          <Picker
                            label="Draft contact"
                            value={draft.contactId ?? 'none'}
                            options={[
                              { value: 'none', label: 'No contact assigned' },
                              ...state!.contacts.map((c) => ({
                                value: c.id,
                                label: c.name,
                              })),
                            ]}
                            onChange={(id) => {
                              const c = state!.contacts.find(
                                (c) => c.id === id,
                              );
                              setDraft({
                                ...draft,
                                contactId: c?.id ?? null,
                                familyId: c?.familyId ?? null,
                                holdingId: c?.holdingId ?? null,
                              });
                            }}
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="draft-subject">
                            Subject
                          </FieldLabel>
                          <Input
                            id="draft-subject"
                            required
                            maxLength={240}
                            value={draft.subject}
                            onChange={(e) =>
                              setDraft({ ...draft, subject: e.target.value })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="draft-body">
                            Message draft
                          </FieldLabel>
                          <Textarea
                            id="draft-body"
                            required
                            rows={12}
                            maxLength={6000}
                            value={draft.body}
                            onChange={(e) =>
                              setDraft({ ...draft, body: e.target.value })
                            }
                          />
                        </Field>
                        <div className={styles.actions}>
                          <Button type="submit" disabled={!!busy}>
                            Save draft
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setDraft(null)}
                          >
                            Cancel
                          </Button>
                          {state!.drafts.some((d) => d.id === draft.id) ? (
                            <Button
                              type="button"
                              variant="ghost"
                              disabled={!!busy}
                              onClick={() =>
                                void run('delete', async () => {
                                  await save({
                                    action: 'delete',
                                    collection: 'drafts',
                                    id: draft.id,
                                  });
                                  setDraft(null);
                                })
                              }
                            >
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      </FieldGroup>
                    </form>
                  </aside>
                ) : null}
              </div>
            </TabsContent>
            <TabsContent value="issuers">
              <div className={styles.row}>
                <p className={styles.muted}>
                  Reviewed aliases connect different reported names.
                  Similar-looking names are never merged automatically.
                </p>
                <Button
                  disabled={!snapshot.canReview || !!busy}
                  onClick={() => {
                    setAlias({
                      id: crypto.randomUUID(),
                      name: '',
                      aliases: [],
                    });
                    setAliasText('');
                  }}
                >
                  <Plus data-icon="inline-start" />
                  Add issuer
                </Button>
              </div>
              <div className={styles.columns}>
                <section className={styles.panel}>
                  <h2>Canonical issuers</h2>
                  {state!.aliases.length ? (
                    state!.aliases.map((a) => (
                      <div className={styles.record} key={a.id}>
                        <div className={styles.row}>
                          <h3>{a.name}</h3>
                          {snapshot.canReview ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={'Edit ' + a.name}
                              onClick={() => {
                                setAlias(a);
                                setAliasText(a.aliases.join('\n'));
                              }}
                            >
                              <Pencil />
                            </Button>
                          ) : null}
                        </div>
                        <p className={styles.muted}>
                          {a.aliases.join(' · ') || 'No additional aliases'}
                        </p>
                      </div>
                    ))
                  ) : (
                    <Blank
                      title="Issuer identities start with evidence"
                      description="Accept a sourced constituent or create a reviewed canonical name. Legal entities and share classes remain distinct unless explicitly mapped."
                    />
                  )}
                </section>
                {alias ? (
                  <aside className={styles.panel}>
                    <h2>Issuer identity</h2>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run('alias', async () => {
                          await save({
                            action: 'alias',
                            value: {
                              ...alias,
                              aliases: aliasText
                                .split('\n')
                                .map((v) => v.trim())
                                .filter(Boolean),
                            },
                          });
                          setAlias(null);
                        });
                      }}
                    >
                      <FieldGroup>
                        <Field>
                          <FieldLabel htmlFor="issuer-name">
                            Canonical name
                          </FieldLabel>
                          <Input
                            id="issuer-name"
                            required
                            maxLength={240}
                            value={alias.name}
                            onChange={(e) =>
                              setAlias({ ...alias, name: e.target.value })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="issuer-aliases">
                            Reported aliases (one per line)
                          </FieldLabel>
                          <Textarea
                            id="issuer-aliases"
                            value={aliasText}
                            onChange={(e) => setAliasText(e.target.value)}
                            maxLength={7200}
                          />
                        </Field>
                        <p className={styles.muted}>
                          Aliases affect subsequent proposals. Existing dated
                          risk mappings retain their recorded labels and source
                          history.
                        </p>
                        <div className={styles.actions}>
                          <Button type="submit" disabled={!!busy}>
                            Save identity
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setAlias(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </FieldGroup>
                    </form>
                  </aside>
                ) : null}
              </div>
            </TabsContent>
          </Tabs>
          <p className={styles.footer}>
            Source indexing is local. Ask Aster currently uses{' '}
            {snapshot.engine.name} · {snapshot.engine.model} ·{' '}
            {snapshot.engine.execution}. Workflow and agentic mode are selected
            independently.
          </p>
        </>
      )}
    </div>
  );
}
