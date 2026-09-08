'use client';

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Bookmark,
  FileText,
  Info,
  Layers3,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  RISK_ASSET_CLASSES,
  RISK_CURRENCIES,
  emptyRiskData,
  riskScenarioSchema,
  type ExposureGroup,
  type RiskScenario,
  type TotalExposure,
} from '@/lib/risk-contract';
import {
  buildTotalExposure,
  RISK_PRESETS,
  runStressScenario,
} from '@/lib/risk-engine';
import { createDemoRiskData, RISK_DEMO_NOTICE } from '@/data/risk-demo';
import {
  FamilyPicker,
  Metric,
  PageHeading,
  Panel,
  Picker,
  dateLabel,
  money,
} from './primitives';
import { useWorkspace } from './workspace-context';
import { RiskMappingEditor } from './risk-editor';
import styles from './risk.module.css';

const points = (value: number | null, digits = 1) =>
  value === null ? '—' : value.toFixed(digits) + '%';
const signed = (value: number) =>
  (value > 0 ? '+' : '') +
  points(value * 100, Number.isInteger(value * 100) ? 0 : 1);
const asStrings = (values: Record<string, number> = {}) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      String(Math.round(value * 10000) / 100),
    ]),
  );
const asShocks = (values: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== '')
      .map(([key, value]) => [key, Number(value) / 100]),
  );

function NoExposure({
  title = 'No exposure to display',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Layers3 />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ExposureBars({
  rows,
  total,
}: {
  rows: ExposureGroup[];
  total: number;
}) {
  return (
    <div className={styles.bars}>
      {rows.map((row) => (
        <div className={styles.barRow} key={row.id}>
          <span className={styles.barName}>{row.name}</span>
          <span className={styles.barValue}>
            {money(row.valueEUR)}
            <small>{points(row.percentage)}</small>
          </span>
          <div className={styles.track} aria-hidden="true">
            <span
              className={
                row.id === '__unknown__' ? styles.unknownBar : undefined
              }
              style={{
                width: `${total ? Math.min(100, (row.valueEUR / total) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ScenarioEditor({
  scenario,
  exposure,
  onClose,
  onApply,
}: {
  scenario: RiskScenario;
  exposure: TotalExposure;
  onClose: () => void;
  onApply: (scenario: RiskScenario) => void;
}) {
  const [classes, setClasses] = useState(() =>
    asStrings(scenario.assetClassShocks),
  );
  const [currencies, setCurrencies] = useState(() =>
    asStrings(scenario.currencyShocks),
  );
  const [sectors, setSectors] = useState(() =>
    asStrings(scenario.sectorShocks),
  );
  const [issuers, setIssuers] = useState(() =>
    asStrings(scenario.issuerShocks),
  );
  const [callRate, setCallRate] = useState(
    String(scenario.capitalCallRate * 100),
  );
  const [sector, setSector] = useState('');
  const [issuer, setIssuer] = useState('');
  const [error, setError] = useState('');
  const knownSectors = exposure.sectorExposure.filter(
    (row) => row.id !== '__unknown__',
  );
  const knownIssuers = exposure.issuerExposure.filter(
    (row) => row.id !== '__unknown__',
  );
  function apply() {
    const parsed = riskScenarioSchema.safeParse({
      id: 'custom',
      name: 'Custom scenario',
      description:
        'Your hypothetical valuation and currency shocks, applied to the current selected portfolio.',
      assetClassShocks: asShocks(classes),
      currencyShocks: asShocks(currencies),
      sectorShocks: asShocks(sectors),
      issuerShocks: asShocks(issuers),
      capitalCallRate: Number(callRate) / 100,
    });
    if (!parsed.success) {
      setError(
        'Use shocks from −100% to +300%, and a capital-call rate from 0% to 100%.',
      );
      return;
    }
    onApply(parsed.data);
    onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>Edit scenario assumptions</DialogTitle>
          <DialogDescription>
            Negative numbers reduce value. Blank removes that assumption;
            lower-priority shocks may still apply. Changes affect this
            simulation only.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <div className={styles.formSection}>
            <h3>Asset-class shocks</h3>
            <FieldGroup className={styles.formGrid}>
              {RISK_ASSET_CLASSES.map((name) => (
                <Field key={name}>
                  <FieldLabel htmlFor={'class-' + name}>{name} (%)</FieldLabel>
                  <Input
                    id={'class-' + name}
                    type="number"
                    min="-100"
                    max="300"
                    step="1"
                    value={classes[name] ?? ''}
                    placeholder="0"
                    onChange={(event) =>
                      setClasses((current) => ({
                        ...current,
                        [name]: event.target.value,
                      }))
                    }
                  />
                </Field>
              ))}
            </FieldGroup>
          </div>
          <div className={styles.formSection}>
            <h3>Effective currency shocks versus EUR</h3>
            <FieldGroup className={styles.formGrid}>
              {RISK_CURRENCIES.filter((value) => value !== 'EUR').map(
                (name) => (
                  <Field key={name}>
                    <FieldLabel htmlFor={'currency-' + name}>
                      {name} (%)
                    </FieldLabel>
                    <Input
                      id={'currency-' + name}
                      type="number"
                      min="-100"
                      max="300"
                      step="1"
                      value={currencies[name] ?? ''}
                      placeholder="0"
                      onChange={(event) =>
                        setCurrencies((current) => ({
                          ...current,
                          [name]: event.target.value,
                        }))
                      }
                    />
                  </Field>
                ),
              )}
            </FieldGroup>
            <p className={styles.note}>
              Currency shocks compound with the valuation shock only where
              effective currency exposure is known.{' '}
              {money(exposure.coverage.currencyUnknownEUR)} has unknown currency
              exposure.
            </p>
          </div>
          <div className={styles.formSection}>
            <h3>Sector overrides</h3>
            <FieldGroup>
              {Object.entries(sectors).map(([name, value]) => (
                <Field key={name}>
                  <FieldLabel htmlFor={'sector-' + name}>{name} (%)</FieldLabel>
                  <div className={styles.actions}>
                    <Input
                      id={'sector-' + name}
                      type="number"
                      min="-100"
                      max="300"
                      value={value}
                      onChange={(event) =>
                        setSectors((current) => ({
                          ...current,
                          [name]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={'Remove ' + name + ' sector override'}
                      onClick={() =>
                        setSectors((current) =>
                          Object.fromEntries(
                            Object.entries(current).filter(
                              ([key]) => key !== name,
                            ),
                          ),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </Field>
              ))}
              {knownSectors.length ? (
                <Field>
                  <FieldLabel>Add a sector override</FieldLabel>
                  <div className={styles.actions}>
                    <Picker
                      value={sector}
                      onChange={setSector}
                      label="Sector to override"
                      options={[
                        { value: '', label: 'Choose a disclosed sector' },
                        ...knownSectors.map((row) => ({
                          value: row.name,
                          label: row.name,
                        })),
                      ]}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!sector || sectors[sector] !== undefined}
                      onClick={() => {
                        setSectors((current) => ({
                          ...current,
                          [sector]: '-20',
                        }));
                        setSector('');
                      }}
                    >
                      <Plus data-icon="inline-start" />
                      Add
                    </Button>
                  </div>
                </Field>
              ) : (
                <p className={styles.note}>
                  Map sector exposures to add a targeted sector override.
                </p>
              )}
            </FieldGroup>
          </div>
          <div className={styles.formSection}>
            <h3>Issuer / company overrides</h3>
            <FieldGroup>
              {Object.entries(issuers).map(([id, value]) => (
                <Field key={id}>
                  <FieldLabel htmlFor={'issuer-' + id}>
                    {knownIssuers.find((row) => row.id === id)?.name ?? id} (%)
                  </FieldLabel>
                  <div className={styles.actions}>
                    <Input
                      id={'issuer-' + id}
                      type="number"
                      min="-100"
                      max="300"
                      value={value}
                      onChange={(event) =>
                        setIssuers((current) => ({
                          ...current,
                          [id]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={'Remove ' + id + ' issuer override'}
                      onClick={() =>
                        setIssuers((current) =>
                          Object.fromEntries(
                            Object.entries(current).filter(
                              ([key]) => key !== id,
                            ),
                          ),
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </Field>
              ))}
              {knownIssuers.length ? (
                <Field>
                  <FieldLabel>Add an issuer override</FieldLabel>
                  <div className={styles.actions}>
                    <Picker
                      value={issuer}
                      onChange={setIssuer}
                      label="Issuer to override"
                      options={[
                        { value: '', label: 'Choose a disclosed issuer' },
                        ...knownIssuers.map((row) => ({
                          value: row.id,
                          label: row.name,
                        })),
                      ]}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!issuer || issuers[issuer] !== undefined}
                      onClick={() => {
                        setIssuers((current) => ({
                          ...current,
                          [issuer]: '-30',
                        }));
                        setIssuer('');
                      }}
                    >
                      <Plus data-icon="inline-start" />
                      Add
                    </Button>
                  </div>
                </Field>
              ) : (
                <p className={styles.note}>
                  Map issuer identities to add a company-specific override.
                </p>
              )}
            </FieldGroup>
          </div>
          <Field>
            <FieldLabel htmlFor="risk-call-rate">
              Unfunded commitments called (%)
            </FieldLabel>
            <Input
              id="risk-call-rate"
              type="number"
              min="0"
              max="100"
              step="1"
              value={callRate}
              onChange={(event) => setCallRate(event.target.value)}
            />
            <FieldDescription>
              Assumed cash demand. A capital call transfers cash into invested
              capital; it is not a valuation loss.
            </FieldDescription>
          </Field>
        </FieldGroup>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <p className={styles.note}>
          Priority: issuer override → sector override → asset-class shock.
          Effective-currency changes then compound. Unknown exposures remain
          visible.
        </p>
        <div className={styles.formActions}>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply}>Apply assumptions</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RiskView({
  family,
  onFamily,
}: {
  family: string;
  onFamily: (value: string) => void;
}) {
  const { state, data, mutate } = useWorkspace();
  const [scenario, setScenario] = useState<RiskScenario>(RISK_PRESETS[0]);
  const [editScenario, setEditScenario] = useState(false);
  const [editMapping, setEditMapping] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [dimension, setDimension] = useState('assetClass');
  const [sourceDetail, setSourceDetail] = useState<string | null>(null);
  const [showAllContributors, setShowAllContributors] = useState(false);
  const canWrite = ['owner', 'admin', 'analyst'].includes(
    state.identity?.role ?? '',
  );
  const holdings = useMemo(
    () =>
      data.holdings.filter(
        (holding) => family === 'all' || holding.familyId === family,
      ),
    [data.holdings, family],
  );
  const riskData = useMemo(
    () =>
      state.riskData ??
      (state.sampleData ? createDemoRiskData(data.holdings) : emptyRiskData()),
    [state.riskData, state.sampleData, data.holdings],
  );
  const analysis = useMemo(() => {
    try {
      const exposure = buildTotalExposure(
        holdings,
        riskData,
        new Date().toISOString().slice(0, 10),
      );
      return {
        exposure,
        stress: runStressScenario(exposure, scenario),
        error: '',
      };
    } catch (cause) {
      return {
        exposure: null,
        stress: null,
        error:
          cause instanceof Error
            ? cause.message
            : 'Exposure analysis is unavailable.',
      };
    }
  }, [holdings, riskData, scenario]);
  const { exposure, stress } = analysis;
  const overlap = useMemo(() => {
    const groups = new Map<
      string,
      {
        name: string;
        managers: Map<string, string>;
        value: number;
        holdings: Set<string>;
      }
    >();
    for (const lot of exposure?.lots ?? []) {
      if (!lot.issuerId || !lot.managerId) continue;
      const group = groups.get(lot.issuerId) ?? {
        name: lot.issuerName ?? lot.issuerId,
        managers: new Map<string, string>(),
        value: 0,
        holdings: new Set<string>(),
      };
      group.managers.set(lot.managerId, lot.managerName ?? lot.managerId);
      group.holdings.add(lot.holdingId);
      group.value += lot.valueEUR;
      groups.set(lot.issuerId, group);
    }
    return [...groups.entries()]
      .map(([id, group]) => ({ id, ...group }))
      .filter((group) => group.managers.size > 1)
      .sort((a, b) => b.value - a.value);
  }, [exposure]);
  const evidence = data.evidence.find((item) => item.id === sourceDetail);
  const issuerRows =
    exposure?.issuerExposure.filter((row) =>
      row.name.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const dimensionRows = exposure
    ? ({
        assetClass: exposure.assetClassExposure,
        sector: exposure.sectorExposure,
        country: exposure.countryExposure,
        currency: exposure.currencyExposure,
      }[dimension] ?? [])
    : [];
  const maxContribution = Math.max(
    1,
    ...(stress?.contributors.map((row) => Math.abs(row.lossEUR)) ?? []),
  );
  const rankedContributors = useMemo(
    () =>
      [...(stress?.contributors ?? [])].sort(
        (a, b) =>
          Math.abs(b.lossEUR) - Math.abs(a.lossEUR) || a.id.localeCompare(b.id),
      ),
    [stress],
  );
  const chips = [
    ...Object.entries(scenario.assetClassShocks),
    ...Object.entries(scenario.currencyShocks ?? {}).map(
      ([key, value]) => [key + ' / EUR', value] as const,
    ),
    ...Object.entries(scenario.sectorShocks ?? {}).map(
      ([key, value]) => [key, value] as const,
    ),
  ].filter(([, value]) => value !== 0);
  async function saveTemplate() {
    if (!templateName.trim()) return;
    setBusy(true);
    const ok = await mutate({
      type: 'riskScenario',
      name: templateName.trim(),
      scenario,
    });
    setNotice(
      ok
        ? 'Scenario template saved. It will use current holdings when reopened.'
        : 'The template could not be saved. Try again.',
    );
    if (ok) setTemplateName('');
    setBusy(false);
  }
  return (
    <div className={styles.root}>
      <PageHeading
        title="Risk & simulation"
        subtitle="See what you own. Explore what could change."
      >
        <FamilyPicker value={family} onChange={onFamily} />
        <Button
          variant="outline"
          disabled={!canWrite || !data.holdings.length}
          onClick={() => setEditMapping(true)}
        >
          <Layers3 data-icon="inline-start" />
          Manage exposures
        </Button>
      </PageHeading>
      <div className={styles.intro}>
        <div className={styles.introIcon}>
          <SlidersHorizontal />
        </div>
        <div>
          <strong>A hypothetical scenario, not a prediction</strong>
          <p>
            Explore the effect of explicit assumptions on your latest recorded
            values. Undisclosed exposures stay visible.
          </p>
        </div>
        <Badge variant="outline">
          {state.sampleData ? 'Synthetic sample data' : 'Recorded portfolio'}
        </Badge>
      </div>
      {state.sampleData ? (
        <p className={styles.note}>{RISK_DEMO_NOTICE}</p>
      ) : null}
      {analysis.error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Analysis needs attention</AlertTitle>
          <AlertDescription>{analysis.error}</AlertDescription>
        </Alert>
      ) : !holdings.length ? (
        <NoExposure title="Start with recorded holdings">
          Add holdings in Investments to explore your portfolio’s exposure and
          scenario sensitivity.
        </NoExposure>
      ) : exposure && stress ? (
        <Tabs defaultValue="simulation" className={styles.stack}>
          <TabsList variant="line">
            <TabsTrigger value="simulation">Simulation</TabsTrigger>
            <TabsTrigger value="exposure">Total exposure</TabsTrigger>
            <TabsTrigger value="evidence">Coverage & evidence</TabsTrigger>
          </TabsList>
          <TabsContent value="simulation" className={styles.stack}>
            <section
              className={styles.scenario}
              aria-label="Scenario assumptions"
            >
              <div className={styles.scenarioTop}>
                <div>
                  <p className={styles.eyebrow}>Scenario workspace</p>
                  <h2>{scenario.name}</h2>
                </div>
                <div className={styles.actions}>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSavedOpen(true)}
                  >
                    <Bookmark data-icon="inline-start" />
                    Saved scenarios
                    {state.riskScenarios?.length
                      ? ` (${state.riskScenarios.length})`
                      : ''}
                  </Button>
                  <Button size="sm" onClick={() => setEditScenario(true)}>
                    <SlidersHorizontal data-icon="inline-start" />
                    Edit assumptions
                  </Button>
                </div>
              </div>
              <ToggleGroup
                variant="outline"
                size="sm"
                className={styles.presets}
                value={[scenario.id]}
                onValueChange={(values) => {
                  const preset = RISK_PRESETS.find(
                    (item) => item.id === values[0],
                  );
                  if (preset) setScenario(preset);
                }}
              >
                {RISK_PRESETS.map((preset) => (
                  <ToggleGroupItem value={preset.id} key={preset.id}>
                    {preset.name}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className={styles.description}>{scenario.description}</p>
              <div className={styles.chips}>
                {chips.map(([name, value]) => (
                  <Badge variant="secondary" key={name}>
                    {name} {signed(value)}
                  </Badge>
                ))}
                {Object.keys(scenario.issuerShocks ?? {}).length ? (
                  <Badge variant="secondary">
                    {Object.keys(scenario.issuerShocks ?? {}).length} issuer
                    overrides
                  </Badge>
                ) : null}
                <Badge variant="outline">
                  Commitments called {points(scenario.capitalCallRate * 100, 0)}
                </Badge>
              </div>
            </section>
            <div className="metrics-row">
              <Metric
                label="Starting value"
                value={money(stress.beforeEUR)}
                note={`${holdings.length} recorded holdings · EUR`}
                help="Latest recorded NAV or equity value of the selected holdings. Unfunded commitments are separate."
              />
              <Metric
                label={stress.lossEUR < 0 ? 'Projected gain' : 'Projected loss'}
                value={money(Math.abs(stress.lossEUR))}
                note={
                  points(
                    stress.lossPercent === null
                      ? null
                      : Math.abs(stress.lossPercent),
                  ) + ' of starting value'
                }
                help="Deterministic change under the chosen shocks. This is not an expected return, prediction, probability or historical replay."
              />
              <Metric
                label="Stressed value"
                value={money(stress.afterEUR)}
                note="Valuation effect · before capital calls"
                help="Starting value after valuation and known effective-currency shocks. Capital-call cash demand is shown separately."
              />
              <Metric
                label="Issuer coverage"
                value={points(exposure.coverage.issuerCoveragePercent)}
                note={
                  money(exposure.coverage.issuerUnknownEUR) +
                  ' unknown or undisclosed'
                }
                help="Share of portfolio value attributed to explicitly mapped issuer identities. Coverage does not verify evidence quality or completeness."
              />
            </div>
            <div className={styles.grid}>
              <Panel
                title="What drives the change"
                subtitle="Contribution by holding · EUR"
                className={styles.panel}
                action={
                  <Badge variant="outline">
                    {stress.lossEUR < 0 ? 'Net gain' : 'Net loss'}
                  </Badge>
                }
              >
                <div className={styles.bars}>
                  {rankedContributors
                    .slice(0, showAllContributors ? undefined : 8)
                    .map((row) => (
                      <div key={row.id} className={styles.barRow}>
                        <span className={styles.barName}>
                          {row.name}
                          <small>
                            {money(row.beforeEUR)} → {money(row.afterEUR)}
                          </small>
                        </span>
                        <span
                          className={cn(
                            styles.barValue,
                            row.lossEUR > 0
                              ? styles.loss
                              : row.lossEUR < 0
                                ? styles.gain
                                : '',
                          )}
                        >
                          {row.lossEUR > 0 ? '−' : row.lossEUR < 0 ? '+' : ''}
                          {money(Math.abs(row.lossEUR))}
                          <small>{points(row.returnPercent)}</small>
                        </span>
                        <div className={styles.track} aria-hidden="true">
                          <span
                            className={
                              row.lossEUR >= 0 ? styles.lossBar : styles.gainBar
                            }
                            style={{
                              width: `${(Math.abs(row.lossEUR) / maxContribution) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                </div>
                {stress.contributors.length > 8 ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="mt-4"
                    onClick={() =>
                      setShowAllContributors((current) => !current)
                    }
                  >
                    {showAllContributors
                      ? 'Show largest changes'
                      : `Show all ${stress.contributors.length} holdings`}
                  </Button>
                ) : null}
                <p className={styles.note}>
                  Underlying allocations replace their parent fund value. Every
                  euro is counted once; shared companies combine across distinct
                  holding paths.
                </p>
              </Panel>
              <div className={styles.stack}>
                <Panel
                  title="Cash under pressure"
                  subtitle="Capital-call stress · separate from valuation loss"
                  className={styles.panel}
                >
                  <dl className={styles.facts}>
                    <dt>Recorded cash</dt>
                    <dd>{money(stress.liquidity.cashBeforeEUR)}</dd>
                    <dt>Cash after valuation / FX shock</dt>
                    <dd>{money(stress.liquidity.cashAfterStressEUR)}</dd>
                    <dt>Unfunded commitments</dt>
                    <dd>{money(stress.liquidity.unfundedCommitmentEUR)}</dd>
                    <dt>Assumed capital calls</dt>
                    <dd>{money(stress.liquidity.capitalCallsEUR)}</dd>
                  </dl>
                  <Separator className={styles.separator} />
                  <dl className={styles.facts}>
                    <dt>Cash after assumed calls</dt>
                    <dd
                      className={
                        stress.liquidity.cashAfterCallsEUR < 0
                          ? styles.loss
                          : undefined
                      }
                    >
                      {money(stress.liquidity.cashAfterCallsEUR)}
                    </dd>
                    <dt>Funding shortfall</dt>
                    <dd>{money(stress.liquidity.shortfallEUR)}</dd>
                  </dl>
                  <p className={styles.note}>
                    Uses recorded cash only. No asset sales, financing,
                    distributions or call timing are assumed. A capital call is
                    cash demand, not a portfolio loss. Cash is pooled across the
                    selected families and entities. Legal transfer restrictions
                    are not modeled; inspect each family separately before
                    relying on the aggregate shortfall.
                  </p>
                </Panel>
                <Panel
                  title="Where the model is incomplete"
                  className={styles.panel}
                >
                  <dl className={styles.facts}>
                    <dt>Unresolved look-through</dt>
                    <dd>{money(stress.unresolvedExposureEUR)}</dd>
                    <dt>Unknown effective currency</dt>
                    <dd>{money(stress.currencyUnresolvedEUR)}</dd>
                    <dt>Unclassified asset exposure</dt>
                    <dd>{money(stress.unclassifiedExposureEUR)}</dd>
                  </dl>
                  <p className={styles.note}>
                    Unresolved fund NAV still receives its disclosed asset-class
                    shock. Issuer shocks cannot reach undisclosed companies.
                    Sector overrides apply only where sector exposure is
                    explicit.
                  </p>
                </Panel>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="exposure" className={styles.stack}>
            <div className={styles.equalGrid}>
              <Panel
                title="Company & issuer exposure"
                subtitle="Direct and fund look-through, combined"
                className={styles.panel}
              >
                <InputGroup className="mb-4">
                  <InputGroupAddon>
                    <Search />
                  </InputGroupAddon>
                  <InputGroupInput
                    aria-label="Search company exposure"
                    placeholder="Find a company or issuer…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </InputGroup>
                {issuerRows.length ? (
                  <Table className={styles.table}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Company / issuer</TableHead>
                        <TableHead className={styles.number}>
                          Exposure
                        </TableHead>
                        <TableHead className={styles.number}>Weight</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {issuerRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            {row.name}
                            <small>
                              {row.holdingCount} holding
                              {row.holdingCount !== 1 ? 's' : ''} ·{' '}
                              {row.pathCount} path
                              {row.pathCount !== 1 ? 's' : ''}
                            </small>
                          </TableCell>
                          <TableCell className={styles.number}>
                            {money(row.valueEUR)}
                          </TableCell>
                          <TableCell className={styles.number}>
                            {points(row.percentage)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <NoExposure>
                    No company exposure matches this search.
                  </NoExposure>
                )}
                <p className={styles.note}>
                  Companies combine only when they share the same explicit
                  issuer ID. Unknown exposure includes unmapped investments and
                  undisclosed fund weights.
                </p>
              </Panel>
              <div className={styles.stack}>
                <Panel
                  title="Underlying allocation"
                  className={styles.panel}
                  action={
                    <Picker
                      value={dimension}
                      onChange={setDimension}
                      label="Exposure dimension"
                      options={[
                        { value: 'assetClass', label: 'Asset class' },
                        { value: 'sector', label: 'Sector' },
                        { value: 'country', label: 'Country' },
                        { value: 'currency', label: 'Effective currency' },
                      ]}
                    />
                  }
                >
                  <ExposureBars
                    rows={dimensionRows}
                    total={exposure.totalValueEUR}
                  />
                  <p className={styles.note}>
                    Reported classifications only. Geography and effective
                    currency are not inferred from a fund’s name or
                    denomination.
                  </p>
                </Panel>
                <Panel
                  title="Exposure by manager"
                  subtitle="Nearest disclosed manager on each holding path"
                  className={styles.panel}
                >
                  <ExposureBars
                    rows={exposure.managerExposure}
                    total={exposure.totalValueEUR}
                  />
                  <p className={styles.note}>
                    Falls back to the holding’s reported manager, which may
                    identify a custodian. Parent and underlying managers are not
                    added together.
                  </p>
                </Panel>
              </div>
            </div>
            <Panel
              title="Shared companies across managers"
              subtitle="Overlap supported by disclosed issuer and manager identities"
              className={styles.panel}
            >
              {overlap.length ? (
                <div className={styles.overlap}>
                  {overlap.map((row) => (
                    <div className={styles.overlapRow} key={row.id}>
                      <div>
                        {row.name}
                        <p>{[...row.managers.values()].join(' · ')}</p>
                        <p>
                          {row.holdings.size} holding
                          {row.holdings.size !== 1 ? 's' : ''}
                        </p>
                      </div>
                      <span className={styles.number}>
                        {money(row.value)}
                        <p>
                          {points((row.value / exposure.totalValueEUR) * 100)}{' '}
                          of portfolio
                        </p>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <NoExposure title="No disclosed manager overlap">
                  No mapped issuer currently appears under more than one
                  attributed manager. Unknown exposure may contain additional
                  overlap.
                </NoExposure>
              )}
            </Panel>
          </TabsContent>
          <TabsContent value="evidence" className={styles.stack}>
            <div className={styles.grid}>
              <Panel
                title="How much can we see?"
                subtitle="Coverage of the selected portfolio by EUR value"
                className={styles.panel}
              >
                <div className={styles.coverageNumber}>
                  {points(exposure.coverage.lookThroughCoveragePercent)}
                  <small>look-through resolved</small>
                </div>
                <div className={styles.coverageTrack} aria-hidden="true">
                  <span
                    style={{
                      width: points(
                        exposure.coverage.lookThroughCoveragePercent,
                      ),
                    }}
                  />
                </div>
                <dl className={styles.facts}>
                  <dt>Resolved asset allocations</dt>
                  <dd>{money(exposure.coverage.lookThroughResolvedEUR)}</dd>
                  <dt>Unresolved fund allocations</dt>
                  <dd>{money(exposure.coverage.lookThroughUnresolvedEUR)}</dd>
                  <dt>Issuer identities known</dt>
                  <dd>{money(exposure.coverage.issuerKnownEUR)}</dd>
                  <dt>Sector known</dt>
                  <dd>{money(exposure.coverage.sectorKnownEUR)}</dd>
                  <dt>Country known</dt>
                  <dd>{money(exposure.coverage.countryKnownEUR)}</dd>
                  <dt>Effective currency known</dt>
                  <dd>{money(exposure.coverage.currencyKnownEUR)}</dd>
                </dl>
                <p className={styles.note}>
                  A resolved allocation can still have an unknown issuer or
                  missing evidence. These dimensions overlap and must not be
                  added together.
                </p>
              </Panel>
              <Panel
                title="Review notes"
                subtitle={`Analysis date ${dateLabel(exposure.asOfDate)}`}
                className={styles.panel}
              >
                {exposure.warnings.length ? (
                  <ul className={styles.warningList}>
                    {exposure.warnings.map((warning, index) => (
                      <li key={warning.code + '-' + index}>
                        <AlertCircle />
                        <span>{warning.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.note}>
                    No structural or source-date warnings were detected. This
                    does not independently verify the mappings.
                  </p>
                )}
              </Panel>
            </div>
            <Panel
              title="Unresolved exposure"
              subtitle="NAV retained without an invented allocation"
              className={styles.panel}
            >
              {exposure.lots.some((lot) => lot.unresolved) ? (
                <Table className={styles.table}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Holding / path</TableHead>
                      <TableHead>What is missing</TableHead>
                      <TableHead className={styles.number}>Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {exposure.lots
                      .filter((lot) => lot.unresolved)
                      .map((lot) => (
                        <TableRow key={lot.id}>
                          <TableCell>
                            {lot.holdingName}
                            <small>
                              {lot.pathNames.join(' → ') || 'No root mapping'}
                            </small>
                          </TableCell>
                          <TableCell>
                            {lot.unresolvedReason}
                            <small>
                              {lot.assetClass
                                ? `Modeled as ${lot.assetClass}`
                                : 'Asset class unknown'}
                            </small>
                          </TableCell>
                          <TableCell className={styles.number}>
                            {money(lot.valueEUR)}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              ) : (
                <NoExposure title="All NAV has a mapped allocation">
                  Review issuer coverage and evidence dates separately to assess
                  the completeness of those allocations.
                </NoExposure>
              )}
            </Panel>
            <Panel
              title="Evidence & assumptions"
              subtitle="Provenance retained along every look-through path"
              className={styles.panel}
            >
              <div className={styles.evidenceList}>
                {exposure.provenance.map((source, index) => {
                  const recorded = data.evidence.find(
                    (item) => item.id === source.sourceId,
                  );
                  return (
                    <div className={styles.evidenceItem} key={index}>
                      <FileText />
                      <div>
                        <h3>{source.label}</h3>
                        <p>
                          {source.asOfDate
                            ? dateLabel(source.asOfDate)
                            : 'As-of date missing'}{' '}
                          · {source.sourceId ?? 'Source reference missing'}
                        </p>
                        {recorded ? (
                          <p>
                            {recorded.subject} · {recorded.filename}, page{' '}
                            {recorded.page}
                          </p>
                        ) : source.sourceId ? (
                          <p>
                            Reference supplied with the mapping; no matching
                            evidence record in this workspace.
                          </p>
                        ) : null}
                      </div>
                      <div className={styles.actions}>
                        <Badge variant="outline">
                          {source.synthetic
                            ? 'Synthetic'
                            : recorded
                              ? 'Recorded source'
                              : 'Unverified'}
                        </Badge>
                        {recorded ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSourceDetail(recorded.id)}
                          >
                            View
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
            <Panel title="Model boundaries" className={styles.panel}>
              <ul className={styles.warningList}>
                {exposure.limitations.map((limitation) => (
                  <li key={limitation}>
                    <Info />
                    <span>{limitation}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </TabsContent>
        </Tabs>
      ) : null}
      <p className={styles.footnote}>
        <Info />
        All figures in EUR. Private holdings use their latest recorded NAV or
        equity value. This model does not estimate probabilities, leverage
        amplification, tax, transaction costs or sale liquidity.
      </p>
      {editScenario && exposure ? (
        <ScenarioEditor
          scenario={scenario}
          exposure={exposure}
          onClose={() => setEditScenario(false)}
          onApply={setScenario}
        />
      ) : null}
      {editMapping ? (
        <RiskMappingEditor
          holdings={holdings}
          allHoldingIds={data.holdings.map((holding) => holding.id)}
          riskData={riskData}
          synthetic={Boolean(state.sampleData)}
          onClose={() => setEditMapping(false)}
          onSave={(mapping) => mutate({ type: 'riskData', data: mapping })}
        />
      ) : null}
      <Dialog open={savedOpen} onOpenChange={setSavedOpen}>
        <DialogContent className={styles.dialog}>
          <DialogHeader>
            <DialogTitle>Saved scenario templates</DialogTitle>
            <DialogDescription>
              Templates store assumptions. They recalculate against your current
              portfolio and selected family each time you open them.
            </DialogDescription>
          </DialogHeader>
          {canWrite ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="risk-template-name">
                  Save current assumptions
                </FieldLabel>
                <div className={styles.actions}>
                  <Input
                    id="risk-template-name"
                    value={templateName}
                    maxLength={100}
                    placeholder="Give this scenario a name"
                    onChange={(event) => setTemplateName(event.target.value)}
                  />
                  <Button
                    disabled={
                      busy ||
                      !templateName.trim() ||
                      (state.riskScenarios?.length ?? 0) >= 20
                    }
                    onClick={() => void saveTemplate()}
                  >
                    <Bookmark data-icon="inline-start" />
                    {busy ? 'Saving…' : 'Save template'}
                  </Button>
                </div>
                <FieldDescription>
                  Up to 20 workspace templates. Current scenario:{' '}
                  {scenario.name}.
                </FieldDescription>
              </Field>
            </FieldGroup>
          ) : null}
          {notice ? (
            <Alert>
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}
          <div className={styles.savedList}>
            {state.riskScenarios?.length ? (
              state.riskScenarios.map((saved) => (
                <div className={styles.savedRow} key={saved.id}>
                  <div>
                    <strong>{saved.name}</strong>
                    <p>Saved {dateLabel(saved.createdAt.slice(0, 10))}</p>
                  </div>
                  <div className={styles.actions}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setScenario({
                          ...saved.scenario,
                          id: saved.id,
                          name: saved.name,
                        });
                        setSavedOpen(false);
                      }}
                    >
                      <RotateCcw data-icon="inline-start" />
                      Open
                    </Button>
                    {canWrite ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={'Delete ' + saved.name + ' template'}
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          const ok = await mutate({
                            type: 'riskScenarioDelete',
                            id: saved.id,
                          });
                          setNotice(
                            ok
                              ? 'Scenario template deleted.'
                              : 'The template could not be deleted.',
                          );
                          setBusy(false);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <NoExposure title="No saved scenarios yet">
                Keep a set of assumptions here to run it again as your portfolio
                changes.
              </NoExposure>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(sourceDetail)}
        onOpenChange={(open) => {
          if (!open) setSourceDetail(null);
        }}
      >
        <DialogContent className={styles.dialog}>
          <DialogHeader>
            <DialogTitle>{evidence?.subject ?? 'Evidence source'}</DialogTitle>
            <DialogDescription>
              {evidence
                ? `${evidence.filename} · page ${evidence.page} · ${dateLabel(evidence.effectiveDate)}`
                : 'Source unavailable'}
            </DialogDescription>
          </DialogHeader>
          {evidence ? (
            <>
              <Badge variant="outline">
                {evidence.synthetic
                  ? 'Synthetic sample evidence'
                  : evidence.status}
              </Badge>
              <p className={styles.description}>{evidence.excerpt}</p>
              <p className={styles.note}>
                From {evidence.sender} · Reference {evidence.id}
              </p>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
