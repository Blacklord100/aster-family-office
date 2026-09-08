'use client';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { FileText, Download, Printer, RefreshCw } from 'lucide-react';
import { Shell, navigation, type View } from './shell';
import { Overview } from './overview';
import { InvestmentsView, InvestmentDetail } from './investments';
import { TimelineView } from './timeline';
import { InboxView } from './inbox';
import { ConnectionsView } from './agents';
import { ProcessingView } from './processing-view';
import { TeamSettings } from './team-settings';
import { ReportsView, PrintableReport, downloadHoldings } from './reports';
import { EvidencePanel } from './evidence';
import { AssistantPanel } from './assistant';
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
type Route = { view: View; family: string; holding: string | null };
const DEFAULT_ROUTE: Route = { view: 'overview', family: 'all', holding: null };
const RiskView = dynamic(() => import('./risk-view').then((module) => module.RiskView));
const EnginesView = dynamic(() => import('./engines-view').then((module) => module.EnginesView));
export function AsterApp() {
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
  const data = useMemo(() => deriveWorkspace(state), [state]);
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/workspace', { cache: 'no-store' });
      if (response.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (response.status === 403) {
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
      setState(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load workspace');
    } finally {
      setLoading(false);
    }
  }, []);
  const mutate = useCallback(async (input: Record<string, unknown>) => {
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
  }, [load]);
  // oxlint-disable-next-line react/react-compiler -- Synchronize client route with the external browser URL after SSR.
  useEffect(() => {
    function read() {
      const p = new URLSearchParams(window.location.search);
      const v = p.get('view') ?? 'overview';
      setRoute({
        view: navigation.some((n) => n.id === v) ? (v as View) : 'overview',
        family: p.get('family') ?? 'all',
        holding: p.get('holding'),
      });
    }
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
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
      const params = new URLSearchParams({
        view: next.view,
        family: next.family,
      });
      if (next.holding) params.set('holding', next.holding);
      window.history.pushState(null, '', '?' + params.toString());
      setRoute(next);
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
    [route],
  );
  const navigate = (view: View) => changeRoute({ view, holding: null });
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
  const preview = (report: SavedReport | null, range = 'YTD') => {
    setSavedReport(report);
    setReportRange(range);
    setReportOpen(true);
  };
  const activeHolding = data.holdings.find((h) => h.id === route.holding);
  const context = {
    state,
    data,
    mutate,
    loading,
    error,
    reload: () => void load(),
  };
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
            {route.view === 'inbox' ? (
              <InboxView
                family={route.family}
                onFamily={family}
                onHolding={openHolding}
              />
            ) : null}
            {route.view === 'agents' ? <ProcessingView /> : null}
            {route.view === 'risk' ? <RiskView family={route.family} onFamily={family} /> : null}
            {route.view === 'engines' ? <EnginesView /> : null}
            {route.view === 'connections' ? <ConnectionsView /> : null}
            {route.view === 'reports' ? (
              <ReportsView
                family={route.family}
                onFamily={family}
                onPreview={preview}
              />
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
                    {navigation.map((n) => (
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
              {canAdmin && state.sampleDataAllowed && !data.holdings.length ? (
                <Button
                  variant="outline"
                  onClick={() => void mutate({ type: 'seed' })}
                >
                  Explore with sample data
                </Button>
              ) : null}
              {canAdmin &&
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
