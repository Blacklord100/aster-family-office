'use client';

import { useState } from 'react';
import { FileJson, Plus, Trash2 } from 'lucide-react';
import type { Holding } from '@/data/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  RISK_ASSET_CLASSES,
  RISK_CURRENCIES,
  riskDataSchema,
  type RiskData,
  type RiskNode,
} from '@/lib/risk-contract';
import { Picker, money } from './primitives';
import styles from './risk.module.css';

type MappingRow = {
  key: string;
  name: string;
  issuerId: string;
  issuerName: string;
  weight: string;
  assetClass: string;
  sector: string;
  country: string;
  currency: string;
};
const blankRow = (): MappingRow => ({
  key: crypto.randomUUID(),
  name: '',
  issuerId: '',
  issuerName: '',
  weight: '',
  assetClass: '',
  sector: '',
  country: '',
  currency: '',
});
const optional = (value: string) => value.trim() || undefined;

function trimUnusedNodes(data: RiskData): RiskData {
  const reachable = new Set(data.positions.map((position) => position.nodeId));
  for (let pass = 0; pass < 20; pass++) {
    const size = reachable.size;
    for (const link of data.links)
      if (reachable.has(link.parentId)) reachable.add(link.childId);
    if (size === reachable.size) break;
  }
  return {
    ...data,
    nodes: data.nodes.filter((node) => reachable.has(node.id)),
    links: data.links.filter(
      (link) => reachable.has(link.parentId) && reachable.has(link.childId),
    ),
  };
}

export function RiskMappingEditor({
  holdings,
  allHoldingIds,
  riskData,
  synthetic,
  onClose,
  onSave,
}: {
  holdings: Holding[];
  allHoldingIds: string[];
  riskData: RiskData;
  synthetic: boolean;
  onClose: () => void;
  onSave: (data: RiskData) => Promise<boolean>;
}) {
  const [tab, setTab] = useState('manual');
  const [holdingId, setHoldingId] = useState(holdings[0]?.id ?? '');
  const [kind, setKind] = useState('fund');
  const [rows, setRows] = useState<MappingRow[]>(() => [blankRow()]);
  const [sourceId, setSourceId] = useState('');
  const [asOfDate, setAsOfDate] = useState('');
  const [json, setJson] = useState(() => JSON.stringify(riskData, null, 2));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const holding = holdings.find((candidate) => candidate.id === holdingId);
  const existing = riskData.positions.some(
    (position) => position.holdingId === holdingId,
  );
  const totalWeight = rows.reduce(
    (sum, row) => sum + (Number(row.weight) || 0),
    0,
  );

  function updateRow(key: string, field: keyof MappingRow, value: string) {
    setRows((current) =>
      current.map((row) =>
        row.key === key ? { ...row, [field]: value } : row,
      ),
    );
    setError('');
  }

  async function save() {
    setError('');
    let proposed: unknown;
    try {
      if (tab === 'import') proposed = JSON.parse(json);
      else {
        if (!holding) throw new Error('Choose a holding to map.');
        const selectedRows = kind === 'direct' ? rows.slice(0, 1) : rows;
        if (selectedRows.some((row) => !row.name.trim()))
          throw new Error('Give each underlying asset a name.');
        if (
          selectedRows.some(
            (row) =>
              Boolean(row.issuerId.trim()) !== Boolean(row.issuerName.trim()),
          )
        )
          throw new Error(
            'Provide both issuer name and issuer ID, or leave both unknown.',
          );
        if (
          kind === 'fund' &&
          selectedRows.some(
            (row) =>
              row.weight !== '' &&
              (!Number.isFinite(Number(row.weight)) ||
                Number(row.weight) < 0 ||
                Number(row.weight) > 100),
          )
        )
          throw new Error(
            'Each weight must be between 0 and 100%, or blank for undisclosed.',
          );
        if (kind === 'fund' && totalWeight > 100)
          throw new Error(
            `Disclosed weights exceed 100% (currently ${totalWeight.toFixed(2)}%). Reduce them before saving.`,
          );
        const rootId = 'mapping-' + crypto.randomUUID();
        const source = {
          sourceId: optional(sourceId),
          asOfDate: optional(asOfDate),
          synthetic,
        };
        const assets: RiskNode[] = selectedRows.map((row, index) => ({
          id: kind === 'direct' ? rootId : rootId + '-' + index,
          kind: 'asset',
          name: row.name.trim(),
          issuerId: optional(row.issuerId),
          issuerName: optional(row.issuerName),
          assetClass: optional(row.assetClass) as RiskNode['assetClass'],
          sector: optional(row.sector),
          country: optional(row.country),
          currency: optional(row.currency) as RiskNode['currency'],
          ...source,
        }));
        const nodes: RiskNode[] =
          kind === 'fund'
            ? [
                {
                  id: rootId,
                  name: holding.name,
                  kind: 'fund',
                  assetClass: holding.assetClass,
                  ...source,
                },
                ...assets,
              ]
            : assets;
        proposed = trimUnusedNodes({
          version: 1,
          nodes: [...riskData.nodes, ...nodes],
          links: [
            ...riskData.links,
            ...(kind === 'fund'
              ? selectedRows.map((row, index) => ({
                  id: rootId + '-link-' + index,
                  parentId: rootId,
                  childId: assets[index].id,
                  weight:
                    row.weight === '' ? undefined : Number(row.weight) / 100,
                  ...source,
                }))
              : []),
          ],
          positions: [
            ...riskData.positions.filter(
              (position) => position.holdingId !== holdingId,
            ),
            { holdingId, nodeId: rootId },
          ],
        });
      }
      const parsed = riskDataSchema.safeParse(proposed);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .slice(0, 3)
            .map(
              (issue) =>
                `${issue.path.length ? issue.path.join('.') + ': ' : ''}${issue.message}`,
            )
            .join(' '),
        );
      const allowedHoldings = new Set(allHoldingIds);
      if (
        parsed.data.positions.some(
          (position) => !allowedHoldings.has(position.holdingId),
        )
      )
        throw new Error(
          'Every holdingId must match an existing holding in this workspace.',
        );
      if (
        !synthetic &&
        [...parsed.data.nodes, ...parsed.data.links].some(
          (item) => item.synthetic,
        )
      )
        throw new Error(
          'Synthetic mappings cannot be imported into a live portfolio. Use evidence for the actual holdings.',
        );
      if (
        new TextEncoder().encode(
          JSON.stringify({ type: 'riskData', data: parsed.data }),
        ).byteLength >
        64 * 1024
      )
        throw new Error(
          'This mapping exceeds the 64 KB save limit. Reduce its size before saving.',
        );
      setBusy(true);
      if (await onSave(parsed.data)) onClose();
      else
        setError(
          'The mapping could not be saved. Your edits are still here; try again.',
        );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Check the mapping and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>Exposure mappings</DialogTitle>
          <DialogDescription>
            Connect a holding to its underlying assets. Weights are shares of
            fund NAV; missing detail stays unknown.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(String(value));
            setError('');
          }}
        >
          <TabsList>
            <TabsTrigger value="manual">Map a holding</TabsTrigger>
            <TabsTrigger value="import">Import JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="manual" className="mt-5">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="risk-mapping-holding">Holding</FieldLabel>
                <Picker
                  id="risk-mapping-holding"
                  label="Holding to map"
                  value={holdingId}
                  onChange={setHoldingId}
                  options={holdings.map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                />
                <FieldDescription>
                  {holding ? money(holding.valueEUR) + ' recorded value. ' : ''}
                  {existing
                    ? 'Saving replaces this holding’s root mapping. Shared mappings for other holdings are preserved.'
                    : 'The recorded investment value remains unchanged.'}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Mapping type</FieldLabel>
                <ToggleGroup
                  value={[kind]}
                  onValueChange={(values) => {
                    if (values[0]) setKind(values[0]);
                  }}
                  variant="outline"
                >
                  <ToggleGroupItem value="fund">
                    Fund look-through
                  </ToggleGroupItem>
                  <ToggleGroupItem value="direct">Direct asset</ToggleGroupItem>
                </ToggleGroup>
              </Field>
              <FieldGroup className={styles.formGrid}>
                <Field>
                  <FieldLabel htmlFor="risk-source-reference">
                    Evidence reference
                  </FieldLabel>
                  <Input
                    id="risk-source-reference"
                    value={sourceId}
                    onChange={(event) => setSourceId(event.target.value)}
                    placeholder="Source ID, report name or citation"
                    maxLength={160}
                  />
                  <FieldDescription>
                    Optional. An entered reference is not independently
                    verified.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="risk-mapping-date">
                    Exposure as of
                  </FieldLabel>
                  <Input
                    id="risk-mapping-date"
                    type="date"
                    value={asOfDate}
                    onChange={(event) => setAsOfDate(event.target.value)}
                  />
                  <FieldDescription>
                    Use the report’s exposure date, when known.
                  </FieldDescription>
                </Field>
              </FieldGroup>
              <div className={styles.editorRows}>
                {(kind === 'direct' ? rows.slice(0, 1) : rows).map(
                  (row, index) => (
                    <div className={styles.rowEditor} key={row.key}>
                      <div className={styles.rowEditorTop}>
                        <span>
                          {kind === 'direct'
                            ? 'Direct asset'
                            : `Underlying asset ${index + 1}`}
                        </span>
                        {kind === 'fund' && rows.length > 1 ? (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Remove underlying asset ${index + 1}`}
                            onClick={() =>
                              setRows((current) =>
                                current.filter((item) => item.key !== row.key),
                              )
                            }
                          >
                            <Trash2 />
                          </Button>
                        ) : null}
                      </div>
                      <FieldGroup className={styles.formGrid}>
                        <Field>
                          <FieldLabel htmlFor={row.key + '-name'}>
                            Asset name
                          </FieldLabel>
                          <Input
                            id={row.key + '-name'}
                            value={row.name}
                            maxLength={240}
                            placeholder="Underlying company or asset"
                            onChange={(event) =>
                              updateRow(row.key, 'name', event.target.value)
                            }
                          />
                        </Field>
                        {kind === 'fund' ? (
                          <Field data-invalid={totalWeight > 100}>
                            <FieldLabel htmlFor={row.key + '-weight'}>
                              Weight in fund (%)
                            </FieldLabel>
                            <Input
                              id={row.key + '-weight'}
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              aria-invalid={totalWeight > 100}
                              value={row.weight}
                              placeholder="Undisclosed"
                              onChange={(event) =>
                                updateRow(row.key, 'weight', event.target.value)
                              }
                            />
                          </Field>
                        ) : null}
                        <Field>
                          <FieldLabel htmlFor={row.key + '-issuer'}>
                            Issuer / company name
                          </FieldLabel>
                          <Input
                            id={row.key + '-issuer'}
                            value={row.issuerName}
                            maxLength={240}
                            placeholder="Unknown"
                            onChange={(event) =>
                              updateRow(
                                row.key,
                                'issuerName',
                                event.target.value,
                              )
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={row.key + '-issuer-id'}>
                            Issuer ID
                          </FieldLabel>
                          <Input
                            id={row.key + '-issuer-id'}
                            value={row.issuerId}
                            maxLength={160}
                            placeholder="Stable ID, e.g. LEI or internal key"
                            onChange={(event) =>
                              updateRow(row.key, 'issuerId', event.target.value)
                            }
                          />
                          <FieldDescription>
                            Reuse the same ID for the same issuer across funds.
                          </FieldDescription>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={row.key + '-class'}>
                            Asset class
                          </FieldLabel>
                          <Picker
                            id={row.key + '-class'}
                            label="Underlying asset class"
                            value={row.assetClass}
                            onChange={(value) =>
                              updateRow(row.key, 'assetClass', value)
                            }
                            options={[
                              {
                                value: '',
                                label: 'Use holding / fund class',
                              },
                              ...RISK_ASSET_CLASSES.map((value) => ({
                                value,
                                label: value,
                              })),
                            ]}
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={row.key + '-currency'}>
                            Effective currency
                          </FieldLabel>
                          <Picker
                            id={row.key + '-currency'}
                            label="Effective currency exposure"
                            value={row.currency}
                            onChange={(value) =>
                              updateRow(row.key, 'currency', value)
                            }
                            options={[
                              { value: '', label: 'Unknown' },
                              ...RISK_CURRENCIES.map((value) => ({
                                value,
                                label: value,
                              })),
                            ]}
                          />
                          <FieldDescription>
                            After known hedges; fund denomination alone is
                            insufficient.
                          </FieldDescription>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={row.key + '-sector'}>
                            Sector
                          </FieldLabel>
                          <Input
                            id={row.key + '-sector'}
                            value={row.sector}
                            maxLength={240}
                            placeholder="Unknown"
                            onChange={(event) =>
                              updateRow(row.key, 'sector', event.target.value)
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={row.key + '-country'}>
                            Country
                          </FieldLabel>
                          <Input
                            id={row.key + '-country'}
                            value={row.country}
                            maxLength={240}
                            placeholder="Unknown"
                            onChange={(event) =>
                              updateRow(row.key, 'country', event.target.value)
                            }
                          />
                        </Field>
                      </FieldGroup>
                    </div>
                  ),
                )}
              </div>
              {kind === 'fund' ? (
                <div className={styles.inlineLabel}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={rows.length >= 50}
                    onClick={() =>
                      setRows((current) => [...current, blankRow()])
                    }
                  >
                    <Plus data-icon="inline-start" />
                    Add underlying asset
                  </Button>
                  <span className={styles.muted}>
                    {totalWeight.toFixed(2)}% disclosed
                  </span>
                </div>
              ) : null}
              <p className={styles.note}>
                Undisclosed weights are never equally allocated. The unmapped
                remainder stays unresolved.{' '}
                {synthetic
                  ? 'This sample workspace saves synthetic mappings.'
                  : 'Use evidence for your actual holdings.'}
              </p>
            </FieldGroup>
          </TabsContent>
          <TabsContent value="import" className="mt-5">
            <FieldGroup>
              <Alert>
                <FileJson />
                <AlertDescription>
                  Import replaces the workspace exposure graph, including other
                  families. It supports nested funds, shared issuers and manager
                  IDs. Review the full JSON before saving.
                </AlertDescription>
              </Alert>
              <Field>
                <FieldLabel htmlFor="risk-json-file">
                  Choose a mapping file
                </FieldLabel>
                <Input
                  id="risk-json-file"
                  type="file"
                  accept=".json,application/json"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 1_000_000) {
                      setError('Use a JSON mapping file smaller than 1 MB.');
                      return;
                    }
                    setJson(await file.text());
                    setError('');
                  }}
                />
              </Field>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="risk-json">Exposure graph JSON</FieldLabel>
                <Textarea
                  id="risk-json"
                  rows={14}
                  aria-invalid={Boolean(error)}
                  value={json}
                  spellCheck={false}
                  onChange={(event) => {
                    setJson(event.target.value);
                    setError('');
                  }}
                />
                <FieldDescription>
                  version: 1, nodes, links and positions. Link weights are
                  decimals (0.15 = 15%). Each position uses an existing
                  holdingId and root nodeId. Duplicate IDs, cycles and weights
                  over 100% are rejected.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </TabsContent>
        </Tabs>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className={styles.formActions}>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || (tab === 'manual' && !holding)}
            onClick={() => void save()}
          >
            {busy
              ? 'Saving…'
              : tab === 'import'
                ? 'Save imported graph'
                : 'Save mapping'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
