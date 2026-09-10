'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FileText, Download, Printer, RefreshCw } from 'lucide-react';
import { Shell, navigation, navigationFor, type View } from './shell';
import { Overview } from './overview';
import { InvestmentsView, InvestmentDetail } from './investments';
import { TimelineView } from './timeline';
import { InboxView } from './inbox';
import { ConnectionsView } from './connections-view';
import { ProcessingView } from './processing-view';
import { TeamSettings } from './team-settings';
import { PrintableReport, downloadHoldings } from './reports';
import { EvidencePanel } from './evidence';
import { AssistantPanel } from './assistant';
import { DemoWorkspaceBanner } from './demo-workspace';
import { PageHeading, FamilyPicker } from './primitives';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { WorkspaceContext } from './workspace-context';
import {
  initialWorkspace,
  deriveWorkspace,
  type WorkspaceState,
  type SavedReport,
} from '@/lib/workspace';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster, toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import {
  FieldGroup,
  Field,
  FieldLabel,
  FieldDescription,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  canonicalWorkspaceView,
  connectionTabFor,
  type ConnectionTab,
} from '@/lib/workspace-navigation';
type Route = {
  view: View;
  family: string;
  holding: string | null;
  jobId: string | null;
  connectionsTab: ConnectionTab;
};
const DEFAULT_ROUTE: Route = {
  view: 'overview',
  family: 'all',
  holding: null,
  jobId: null,
  connectionsTab: 'folders',
};
const ReportingCalendarView = dynamic(() =>
  import('./reporting-calendar').then((module) => module.ReportingCalendarView),
);
const ExceptionInboxView = dynamic(() =>
  import('./exception-inbox').then((module) => module.ExceptionInboxView),
);
const ReportingWorkbench = dynamic(() =>
  import('./reporting-workbench').then((module) => module.ReportingWorkbench),
);
const LedgerView = dynamic(() =>
  import('./ledger-view').then((module) => module.LedgerView),
);
const IntelligenceView = dynamic(() =>
  import('./intelligence-view').then((module) => module.IntelligenceView),
);
const OperationsView = dynamic(() =>
  import('./operations-view').then((module) => module.OperationsView),
);
const RiskView = dynamic(() =>
  import('./risk-view').then((module) => module.RiskView),
);
export function AsterApp() {
  const searchQuery = useSearchParams().toString();
  const [route, setRoute] = useState<Route>(DEFAULT_ROUTE),
    [state, setState] = useState<WorkspaceState>(() => initialWorkspace(false)),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false),
    [askOpen, setAskOpen] = useState(false),
    [source, setSource] = useState<string | null>(null),
    [settingsOpen, setSettingsOpen] = useState(false),
    [workspaceName, setWorkspaceName] = useState('Aster Family Office'),
    [resetConfirm, setResetConfirm] = useState(false);
  const [reportOpen, setReportOpen] = useState(false),
    [savedReport, setSavedReport] = useState<SavedReport | null>(null),
    [reportRange, setReportRange] = useState('YTD');
  const canAdmin = ['owner', 'admin'].includes(state.identity?.role ?? '');
  const identityRole = state.identity?.role;
  const hasDataScope = Boolean(state.identity?.dataScope);
  const data = useMemo(() => deriveWorkspace(state), [state]);
  const loadInFlight = useRef(false);
  const stateEpoch = useRef(0);
  const load = useCallback(async () => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    const epoch = stateEpoch.current;
    try {
      const response = await fetch('/api/workspace', { cache: 'no-store' });
      if (response.status === 401) {
        setState(initialWorkspace(false));
        window.location.assign('/login');
        return;
      }
      if (response.status === 403) {
        setState(initialWorkspace(false));
        const body = await response.json();
        if (body.error === 'MFA_REQUIRED') {
          window.location.assign('/account');
          return;
        }
        throw new Error(body.message);
      }
      if (!response.ok)
        throw new Error('Workspace storage is temporarily unavailable.');
      const next = (await response.json()) as WorkspaceState & {
        error?: string;
        message?: string;
      };
      if (epoch === stateEpoch.current) {
        setState(next);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load workspace');
    } finally {
      loadInFlight.current = false;
      setLoading(false);
    }
  }, []);
  const mutate = useCallback(async (input: Record<string, unknown>) => {
    stateEpoch.current += 1;
    try {
      const response = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const next = (await response.json()) as WorkspaceState & {
        error?: string;
        message?: string;
      };
      if (!response.ok) throw new Error(next.message || 'Could not save');
      stateEpoch.current += 1;
      setState(next);
      setError(null);
      if (!['advance', 'run'].includes(String(input.type)))
        toast.add({
          title:
            input.type === 'report'
              ? 'Report snapshot saved'
              : input.type === 'sync'
                ? 'Demo sync complete'
                : input.type === 'reset'
                  ? 'Sample data cleared'
                  : 'Changes saved',
          type: 'success',
        });
      return true;
    } catch (e) {
      toast.add({
        title: e instanceof Error ? e.message : 'Could not save the change',
        type: 'error',
      });
      return false;
    }
  }, []);
  // oxlint-disable-next-line react/react-compiler -- Load durable state from the server after hydration.
  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- Async server hydration; state changes after the fetch resolves.
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    const refreshWhenVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load]);
  // oxlint-disable-next-line react/react-compiler -- Synchronize client route with the external browser URL after SSR.
  useEffect(() => {
    function read() {
      const p = new URLSearchParams(searchQuery);
      const v = canonicalWorkspaceView(
        p.get('view') ?? 'overview',
        identityRole ? { role: identityRole, dataScope: hasDataScope } : null,
      );
      setRoute({
        view: navigation.some((n) => n.id === v) ? (v as View) : 'overview',
        family: p.get('family') ?? 'all',
        holding: p.get('holding'),
        jobId: p.get('jobId'),
        connectionsTab: connectionTabFor(p),
      });
    }
    read();
  }, [searchQuery, identityRole, hasDataScope]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const changeRoute = useCallback(
    (changes: Partial<Route>) => {
      const next = { ...route, ...changes };
      if (next.view === 'engines') {
        next.view = 'connections';
        next.connectionsTab = 'engines';
      }
      next.view = canonicalWorkspaceView(next.view, state.identity) as View;
      const params = new URLSearchParams({
        view: next.view,
        family: next.family,
      });
      if (next.view === route.view && next.holding === route.holding) {
        const current = new URLSearchParams(window.location.search);
        for (const [key, value] of current)
          if (
            key.startsWith('history') ||
            key === 'activityMode' ||
            key === 'activityOrder' ||
            key === 'investmentTab'
          )
            params.set(key, value);
        if (next.family === route.family && current.has('observation'))
          params.set('observation', current.get('observation')!);
      }
      if (next.holding) params.set('holding', next.holding);
      if (next.view === 'agents' && next.jobId) params.set('jobId', next.jobId);
      if (next.view === 'connections') params.set('tab', next.connectionsTab);
      window.history.pushState(null, '', '?' + params.toString());
      setRoute(next);
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
    [route, state.identity],
  );
  const navigate = (view: View) =>
    changeRoute({
      view,
      holding: null,
      jobId: null,
      connectionsTab: 'folders',
    });
  const family = (family: string) => changeRoute({ family, holding: null });
  const openHolding = (id: string) => {
    setSource(null);
    setSearchOpen(false);
    setAskOpen(false);
    changeRoute({ view: 'investments', holding: id });
  };
  const openSource = (id: string) => {
    setSearchOpen(false);
    setAskOpen(false);
    setSource(id);
  };
  const openOriginal = (id: string) => {
    window.open(
      '/api/documents/' + encodeURIComponent(id) + '/preview',
      '_blank',
      'noopener,noreferrer',
    );
  };
  const openReview = (jobId: string) =>
    changeRoute({ view: 'agents', holding: null, jobId });
  const preview = (report: SavedReport | null, range = 'YTD') => {
    setSavedReport(report);
    setReportRange(range);
    setReportOpen(true);
  };
  const liveDemo = state.demo;
  const activeHolding = data.holdings.find((h) => h.id === route.holding);
  const context = {
    revision: state.workspaceRevision ?? -1,
    state,
    data,
    mutate,
    loading,
    error,
    reload: () => void load(),
  };
  const viewAllowed = navigationFor(state.identity).some(
    (item) => item.id === route.view,
  );
  const pendingReviews = data.evidence.filter(
    (e) => (state.reviews[e.id] ?? e.status) === 'Needs review',
  ).length;
  return (
    <TooltipProvider>
      <Toaster>
        <WorkspaceContext.Provider value={context}>
          <Shell
            view={route.view}
            family={route.family}
            title={activeHolding?.name}
            onNavigate={navigate}
            onFamily={family}
            onSearch={() => setSearchOpen(true)}
            onAsk={() => setAskOpen(true)}
            onSettings={() => {
              setWorkspaceName(state.officeName);
              setSettingsOpen(true);
            }}
            workspaceName={state.officeName}
            inboxCount={pendingReviews}
          >
            {liveDemo ? <DemoWorkspaceBanner demo={liveDemo} /> : null}
            {!loading && !viewAllowed ? (
              <Alert>
                <AlertDescription>
                  This page is unavailable for your workspace access.
                  <Button variant="link" onClick={() => navigate('overview')}>
                    Open overview
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert className="storage-alert">
                <AlertDescription>
                  {error}
                  <Button variant="link" onClick={() => void load()}>
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {route.view === 'overview' ? (
              <Overview
                family={route.family}
                onFamily={family}
                onNavigate={navigate}
                onHolding={openHolding}
                onSource={openSource}
                onExport={() => preview(null)}
                taskStatus={state.taskStatus}
              />
            ) : null}
            {route.view === 'investments' ? (
              activeHolding ? (
                <InvestmentDetail
                  key={activeHolding.id}
                  id={activeHolding.id}
                  onBack={() => navigate('investments')}
                  onSource={openSource}
                  onHolding={openHolding}
                />
              ) : (
                <InvestmentsView
                  family={route.family}
                  onFamily={family}
                  onHolding={openHolding}
                  onExport={() => preview(null)}
                  onManagers={() => navigate('intelligence')}
                />
              )
            ) : null}
            {route.view === 'timeline' ? (
              <TimelineView
                family={route.family}
                onFamily={family}
                onSource={openSource}
              />
            ) : null}
            {route.view === 'inbox' && state.identity?.dataScope ? (
              <InboxView
                family={route.family}
                onFamily={family}
                onHolding={openHolding}
              />
            ) : null}
            {route.view === 'ledger' ? (
              <LedgerView family={route.family} onFamily={family} />
            ) : null}
            {route.view === 'exceptions' ? (
              <ExceptionInboxView
                family={route.family}
                onFamily={family}
                onHolding={openHolding}
                onSource={openOriginal}
                onReview={openReview}
              />
            ) : null}
            {route.view === 'calendar' ? (
              <ReportingCalendarView
                family={route.family}
                onFamily={family}
                onHolding={openHolding}
                onSource={openOriginal}
                onReview={openReview}
              />
            ) : null}
            {route.view === 'intelligence' && !state.identity?.dataScope ? (
              <>
                <div className="workspace-subnavigation">
                  <Button
                    variant="ghost"
                    onClick={() => navigate('investments')}
                  >
                    Back to investments
                  </Button>
                </div>
                <IntelligenceView family={route.family} />
              </>
            ) : null}
            {route.view === 'operations' && canAdmin ? (
              <OperationsView />
            ) : null}
            {route.view === 'setup' && !hasDataScope ? (
              <Tabs defaultValue="register">
                <PageHeading
                  title="Office setup"
                  subtitle="Families, legal entities, accounts and workspace administration."
                />
                <TabsList variant="line" className="workspace-subnavigation">
                  <TabsTrigger value="register">
                    Families & accounts
                  </TabsTrigger>
                  {canAdmin ? (
                    <TabsTrigger value="operations">
                      Service operations
                    </TabsTrigger>
                  ) : null}
                  <TabsTrigger value="team">Team & access</TabsTrigger>
                </TabsList>
                <TabsContent value="register">
                  <LedgerView
                    family={route.family}
                    onFamily={family}
                    mode="setup"
                  />
                </TabsContent>
                {canAdmin ? (
                  <TabsContent value="operations">
                    <OperationsView />
                  </TabsContent>
                ) : null}
                <TabsContent value="team">
                  <TeamSettings />
                </TabsContent>
              </Tabs>
            ) : null}
            {route.view === 'agents' && state.identity && !hasDataScope ? (
              <ProcessingView
                key={route.jobId ?? 'processing'}
                initialJobId={route.jobId}
              />
            ) : null}
            {route.view === 'risk' ? (
              <RiskView family={route.family} onFamily={family} />
            ) : null}
            {route.view === 'connections' && state.identity && !hasDataScope ? (
              <ConnectionsView
                tab={route.connectionsTab}
                onTabChange={(connectionsTab) =>
                  changeRoute({ connectionsTab })
                }
                onDocuments={() => navigate('agents')}
              />
            ) : null}
            {route.view === 'reports' ? (
              <>
                <PageHeading
                  title="Reports"
                  subtitle="Reproducible reporting, reconciled cash flows and portfolio scenarios."
                >
                  <FamilyPicker value={route.family} onChange={family} />
                  <Button
                    variant="outline"
                    onClick={() => navigate('calendar')}
                  >
                    Reporting calendar
                  </Button>
                </PageHeading>
                <ReportingWorkbench
                  key={`${state.identity?.organizationId ?? 'loading'}:${route.family}`}
                  family={route.family}
                  onFamily={family}
                  onSource={openSource}
                  onLegacyPreview={preview}
                />
              </>
            ) : null}
          </Shell>
          <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
            <DialogContent className="search-dialog" showCloseButton={false}>
              <DialogHeader className="sr-only">
                <DialogTitle>Search Aster</DialogTitle>
                <DialogDescription>
                  Find investments, sources and workspace pages.
                </DialogDescription>
              </DialogHeader>
              <Command>
                <CommandInput
                  placeholder="Search investments, documents, anything…"
                  aria-label="Search Aster"
                />
                <CommandList>
                  <CommandEmpty>No matching records.</CommandEmpty>
                  <CommandGroup heading="Workspace">
                    {navigationFor(state.identity).map((n) => (
                      <CommandItem
                        key={n.id}
                        onSelect={() => {
                          navigate(n.id);
                          setSearchOpen(false);
                        }}
                      >
                        <n.icon />
                        {n.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  <CommandGroup heading="Investments">
                    {data.holdings.map((h) => (
                      <CommandItem
                        key={h.id}
                        value={h.name + ' ' + h.manager + ' ' + h.familyId}
                        onSelect={() => openHolding(h.id)}
                      >
                        <FileText />
                        <span>{h.name}</span>
                        <span className="command-meta">{h.familyId}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </DialogContent>
          </Dialog>
          <Sheet
            open={source !== null}
            onOpenChange={(open) => {
              if (!open) setSource(null);
            }}
          >
            <SheetContent className="source-sheet">
              <SheetHeader className="sr-only">
                <SheetTitle>Investment source evidence</SheetTitle>
                <SheetDescription>
                  Original source passage and linked work.
                </SheetDescription>
              </SheetHeader>
              {source ? (
                <EvidencePanel sourceId={source} onHolding={openHolding} />
              ) : null}
            </SheetContent>
          </Sheet>
          <Sheet open={askOpen} onOpenChange={setAskOpen}>
            <SheetContent className="ask-sheet">
              <SheetHeader>
                <SheetTitle>Ask Aster</SheetTitle>
                <SheetDescription>
                  {route.family === 'all'
                    ? 'All families'
                    : route.family + ' family'}{' '}
                  · Investment knowledge
                </SheetDescription>
              </SheetHeader>
              <AssistantPanel family={route.family} onSource={openSource} />
            </SheetContent>
          </Sheet>
          <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
            <DialogContent className="settings-dialog max-h-[90dvh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Workspace settings</DialogTitle>
                <DialogDescription>
                  Organization settings, access and audit history.
                </DialogDescription>
              </DialogHeader>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await mutate({ type: 'settings', name: workspaceName }))
                    setSettingsOpen(false);
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="workspace-name">
                      Workspace name
                    </FieldLabel>
                    <Input
                      id="workspace-name"
                      disabled={!canAdmin}
                      value={workspaceName}
                      onChange={(e) => setWorkspaceName(e.target.value)}
                      minLength={2}
                      maxLength={80}
                      required
                    />
                    <FieldDescription>
                      Saved to your organization’s encrypted workspace.
                    </FieldDescription>
                  </Field>
                  <Button type="submit" disabled={!canAdmin}>
                    Save changes
                  </Button>
                </FieldGroup>
              </form>
              <div className="settings-demo-note">
                <strong>Local processing</strong>
                <p>
                  Documents are processed by your configured private worker.
                  Workflow and agentic modes use the same source review process.
                </p>
              </div>
              <Link
                href="/account"
                className="text-sm underline underline-offset-4"
              >
                Account security & sessions
              </Link>
              <TeamSettings />
              {canAdmin &&
              !state.demo &&
              state.sampleDataAllowed &&
              !data.holdings.length ? (
                <Button
                  variant="outline"
                  onClick={() => void mutate({ type: 'seed' })}
                >
                  Explore with sample data
                </Button>
              ) : null}
              {canAdmin &&
              !state.demo &&
              state.sampleData &&
              !data.evidence.some((e) => !e.synthetic) ? (
                <Button variant="outline" onClick={() => setResetConfirm(true)}>
                  <RefreshCw data-icon="inline-start" />
                  Clear sample workspace
                </Button>
              ) : null}
            </DialogContent>
          </Dialog>
          <Dialog open={resetConfirm} onOpenChange={setResetConfirm}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Clear the sample workspace?</DialogTitle>
                <DialogDescription>
                  This removes sample records and saved sample reports. Uploaded
                  documents and processing jobs are retained. Live investment
                  records cannot be reset.
                </DialogDescription>
              </DialogHeader>
              <Button
                variant="destructive"
                onClick={async () => {
                  if (await mutate({ type: 'reset' })) {
                    setResetConfirm(false);
                    setSettingsOpen(false);
                  }
                }}
              >
                Clear sample data
              </Button>
              <Button variant="outline" onClick={() => setResetConfirm(false)}>
                Keep my changes
              </Button>
            </DialogContent>
          </Dialog>
          <Dialog open={reportOpen} onOpenChange={setReportOpen}>
            <DialogContent className="report-dialog">
              <DialogHeader className="sr-only">
                <DialogTitle>Portfolio report preview</DialogTitle>
                <DialogDescription>
                  Printable portfolio report with allocation and source dates.
                </DialogDescription>
              </DialogHeader>
              <div className="report-actions">
                <Button
                  variant="outline"
                  onClick={() =>
                    downloadHoldings(
                      savedReport?.holdings ??
                        data.holdings.filter(
                          (h) =>
                            route.family === 'all' ||
                            h.familyId === route.family,
                        ),
                      savedReport?.family ?? route.family,
                    )
                  }
                >
                  <Download data-icon="inline-start" />
                  Download CSV
                </Button>
                <Button onClick={() => window.print()}>
                  <Printer data-icon="inline-start" />
                  Print / Save PDF
                </Button>
              </div>
              <PrintableReport
                family={route.family}
                saved={savedReport}
                range={reportRange}
              />
            </DialogContent>
          </Dialog>
        </WorkspaceContext.Provider>
      </Toaster>
    </TooltipProvider>
  );
}
