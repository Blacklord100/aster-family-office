import type { Holding } from '../data/types';
import { emptyRiskData, riskDataSchema, type RiskData } from './risk-contract';
import {
  intelligenceDate,
  intelligenceStateSchema,
  type IntelligenceState,
  type IndexedDocument,
  type ConstituentProposal,
  type IssuerAlias,
  type SearchHit,
  type Calculation,
} from './intelligence-contract';

export class IntelligenceError extends Error {}
/** Legal suffixes and share classes are retained. Only an explicit reviewed alias merges different names. */
export const issuerKey = (name: string) =>
  name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function validateAliases(aliases: IssuerAlias[]) {
  const used = new Map<string, string>();
  for (const alias of aliases)
    for (const value of [alias.name, ...alias.aliases]) {
      const key = issuerKey(value);
      if (!key)
        throw new IntelligenceError('Issuer names need letters or digits.');
      if (used.has(key) && used.get(key) !== alias.id)
        throw new IntelligenceError(
          'This issuer name or alias already identifies a different issuer.',
        );
      used.set(key, alias.id);
    }
  if (new Set(aliases.map((a) => a.id)).size !== aliases.length)
    throw new IntelligenceError('Issuer IDs must be unique.');
  return aliases;
}
export function resolveIssuer(name: string, aliases: IssuerAlias[]) {
  return (
    aliases.find((a) =>
      [a.name, ...a.aliases].some(
        (value) => issuerKey(value) === issuerKey(name),
      ),
    ) ?? null
  );
}

/** Reuse explicit issuer identities already recorded in the reviewed risk graph. No fuzzy merging. */
export function withRecordedIssuers(
  state: IntelligenceState,
  risk?: RiskData,
): IntelligenceState {
  const next = structuredClone(state);
  for (const node of risk?.nodes ?? []) {
    if (
      !node.issuerId ||
      !node.issuerName ||
      next.aliases.some((a) => a.id === node.issuerId)
    )
      continue;
    if (
      next.aliases.length >= 300 ||
      resolveIssuer(node.issuerName, next.aliases)
    )
      continue;
    next.aliases.push({
      id: node.issuerId,
      name: node.issuerName,
      aliases: [],
    });
  }
  return next;
}
const negative =
  /\b(illustrat(?:ion|ive)|hypothetical|example only|withdrawn|superseded|not held|watchlist|prospective)\b/i;
/** Conservative source rows only. Unsupported layouts produce no proposal, never inferred weights. */
export function constituentProposals(
  doc: IndexedDocument,
  holdingId: string,
  aliases: IssuerAlias[],
  now = new Date().toISOString(),
  id = () => crypto.randomUUID(),
): ConstituentProposal[] {
  const output: ConstituentProposal[] = [];
  let excluded = false;
  for (const page of doc.pages) {
    const lines = [...page.text.matchAll(/[^\n]+/g)];
    let section = false;
    let headerOffset = 0;
    for (const line of lines) {
      const value = line[0].trim();
      if (negative.test(value)) {
        section = false;
        excluded = true;
        continue;
      }
      if (
        /^(?:actual|current|reported)\s+(?:portfolio companies|underlying (?:investments|holdings)|constituents|portfolio holdings)\b/i.test(
          value,
        )
      ) {
        excluded = false;
        section = true;
        headerOffset = line.index;
        continue;
      }
      if (excluded) continue;
      const heading =
        /^(?:portfolio companies|underlying (?:investments|holdings)|constituents|portfolio holdings)\b/i.test(
          value,
        );
      if (
        heading ||
        /^(?:company|issuer|constituent)\s*(?:\||\t|;).*?(?:weight|% of (?:nav|portfolio))/i.test(
          value,
        )
      ) {
        // A generic column header belongs to its preceding dated section.
        // Keep that contiguous context instead of dropping the reported date.
        if (heading || !section) headerOffset = line.index;
        section = true;
        continue;
      }
      if (!section) continue;
      if (
        /^(?:notes?|disclaimer|outlook|performance|contact|investment|fund|total)\s*[:|]/i.test(
          value,
        )
      ) {
        section = false;
        continue;
      }
      const match = value.match(
        /^([^|;\t]{2,200}?)\s*(?:\||;|\t| — | – )\s*(\d{1,3}(?:\.\d{1,4})?\s*%|unknown|undisclosed|not disclosed|n\/a|—)\s*$/i,
      );
      if (!match) continue;
      const name = match[1].trim();
      if (!/[\p{L}]/u.test(name) || negative.test(name)) continue;
      const weight = match[2].includes('%')
        ? Number(match[2].replace(/[\s%]/g, '')) / 100
        : null;
      if (weight !== null && (!Number.isFinite(weight) || weight > 1)) continue;
      const end = line.index + line[0].length;
      const block = page.text.slice(headerOffset, end);
      const quote = block.length <= 3000 ? block : line[0];
      const dateMatches = [
        ...quote.matchAll(
          /\b(?:as of|as at|date)\b\s*:?\s*(\d{4}-\d{2}-\d{2})/gi,
        ),
      ].map((m) => m[1]);
      const date =
        dateMatches.length === 1 &&
        intelligenceDate.safeParse(dateMatches[0]).success
          ? dateMatches[0]
          : null;
      const issuer = resolveIssuer(name, aliases);
      output.push({
        id: id(),
        holdingId,
        issuerName: name,
        issuerId: issuer?.id ?? null,
        weight,
        asOfDate: date,
        citation: {
          documentId: doc.documentId,
          page: page.number,
          quote,
          source: page.source,
          contentHash: doc.contentHash,
        },
        status: 'pending',
        createdAt: now,
        reviewedAt: null,
      });
      if (output.length >= 50) return output;
    }
  }
  return output;
}
export function validateCitation(
  proposal: ConstituentProposal,
  doc: IndexedDocument,
) {
  const c = proposal.citation;
  if (
    c.documentId !== doc.documentId ||
    c.contentHash !== doc.contentHash ||
    !doc.pages.some(
      (p) =>
        p.number === c.page &&
        p.source === c.source &&
        p.text.includes(c.quote),
    )
  )
    throw new IntelligenceError(
      'The source citation no longer matches the indexed original. Re-index and review it.',
    );
}
export function acceptConstituent(
  state: IntelligenceState,
  risk: RiskData | undefined,
  proposalId: string,
  holdings: Pick<Holding, 'id' | 'name'>[],
  chosenIssuer?: string,
  sourceId = 'intelligence-' + proposalId,
) {
  const next = structuredClone(state),
    graph = structuredClone(risk ?? emptyRiskData());
  const proposal = next.proposals.find((p) => p.id === proposalId);
  if (!proposal || proposal.status !== 'pending')
    throw new IntelligenceError('This proposal is no longer pending.');
  const holding = holdings.find((h) => h.id === proposal.holdingId);
  if (!holding)
    throw new IntelligenceError(
      'Link this proposal to an accessible existing holding.',
    );
  let issuer = next.aliases.find(
    (a) => a.id === (chosenIssuer ?? proposal.issuerId),
  );
  if (chosenIssuer && !issuer)
    throw new IntelligenceError('Choose an existing canonical issuer.');
  if (!issuer) {
    issuer = {
      id: 'issuer-' + crypto.randomUUID(),
      name: proposal.issuerName,
      aliases: [],
    };
    next.aliases.push(issuer);
  }
  validateAliases(next.aliases);
  let position = graph.positions.find((p) => p.holdingId === holding.id);
  if (!position) {
    const rootId = 'fund-' + crypto.randomUUID();
    graph.nodes.push({ id: rootId, name: holding.name, kind: 'fund' });
    position = { holdingId: holding.id, nodeId: rootId };
    graph.positions.push(position);
  }
  if (graph.nodes.find((n) => n.id === position.nodeId)?.kind !== 'fund')
    throw new IntelligenceError(
      'The existing root is a direct asset. Review its risk mapping before adding constituents.',
    );
  const nodeId = 'constituent-' + issuer.id;
  if (!graph.nodes.some((n) => n.id === nodeId))
    graph.nodes.push({
      id: nodeId,
      name: issuer.name,
      issuerId: issuer.id,
      issuerName: issuer.name,
      kind: 'asset',
      sourceId,
      ...(proposal.asOfDate ? { asOfDate: proposal.asOfDate } : {}),
    });
  const existing = graph.links.find(
    (l) => l.parentId === position.nodeId && l.childId === nodeId,
  );
  if (existing)
    throw new IntelligenceError(
      'This issuer already has a mapping in this fund. Review the existing dated weight in Risk before replacing it.',
    );
  graph.links.push({
    id: 'link-' + proposal.id,
    parentId: position.nodeId,
    childId: nodeId,
    ...(proposal.weight !== null ? { weight: proposal.weight } : {}),
    ...(proposal.asOfDate ? { asOfDate: proposal.asOfDate } : {}),
    sourceId,
  });
  const validated = riskDataSchema.safeParse(graph);
  if (!validated.success)
    throw new IntelligenceError(
      'This proposal would create an invalid graph or exceed disclosed weight limits. Review the fund mappings first.',
    );
  proposal.status = 'accepted';
  proposal.issuerId = issuer.id;
  proposal.reviewedAt = new Date().toISOString();
  return {
    intelligence: intelligenceStateSchema.parse(next),
    riskData: validated.data,
  };
}
const tokens = (text: string) =>
  [
    ...new Set(
      issuerKey(text)
        .split(' ')
        .filter((x) => x.length > 2),
    ),
  ].slice(0, 30);
export function searchDocuments(
  documents: IndexedDocument[],
  query: string,
  limit = 12,
): SearchHit[] {
  const terms = tokens(query);
  const hits: SearchHit[] = [];
  if (!terms.length) return hits;
  for (const doc of documents)
    for (const page of doc.pages) {
      for (let start = 0; start < page.text.length; start += 1400) {
        const quote = page.text.slice(start, start + 1800);
        const normalized = issuerKey(quote);
        const score = terms.reduce(
          (n, t) => n + (normalized.includes(t) ? 1 : 0),
          0,
        );
        if (score > 0)
          hits.push({
            id: doc.documentId + ':' + page.number + ':' + start,
            documentId: doc.documentId,
            filename: doc.filename,
            page: page.number,
            source: page.source,
            quote,
            contentHash: doc.contentHash,
            score,
          });
      }
    }
  return hits
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}
/** Uses recorded cents; model output never contributes amounts or selects hidden holdings. */
export function recordedCalculations(holdings: Holding[]): Calculation[] {
  const records: [
    string,
    string,
    Holding[],
    (h: Holding) => number,
    'valuationStatus' | 'unfundedStatus',
  ][] = [
    [
      'nav',
      'Recorded portfolio value',
      holdings,
      (h) => h.valueEUR,
      'valuationStatus',
    ],
    [
      'cash',
      'Recorded cash',
      holdings.filter((h) => h.assetClass === 'Cash'),
      (h) => h.valueEUR,
      'valuationStatus',
    ],
    [
      'unfunded',
      'Recorded unfunded commitments',
      holdings,
      (h) => h.unfundedCommitmentEUR,
      'unfundedStatus',
    ],
  ];
  return records.flatMap(([id, label, rows, value, status]) => {
    const known = rows.filter((h) => h[status] !== 'unknown');
    if (!known.length) return []; // No records is unavailable, not verified zero cash/NAV/commitments.
    const complete = known.length === rows.length;
    const unknownLiquidity = rows.filter(
      (h) => h.liquidityStatus === 'unknown',
    );
    const inferredAssetClasses = rows.filter(
      (h) => h.assetClassStatus === 'inferred',
    ).length;
    return [
      {
        id,
        label: complete
          ? label
          : `Known ${label.toLowerCase()} (${known.length}/${rows.length} holdings)`,
        valueEUR:
          known.reduce((sum, h) => sum + Math.round(value(h) * 100), 0) / 100,
        holdingIds: known.map((h) => h.id),
        basis: `${complete ? 'Complete recorded' : 'Partial known'} subtotal from ${known.length} of ${rows.length} accessible holding records. Missing values are excluded and are not confirmed zero. Marks may have different dates; cash transferability and settlement are not established.${unknownLiquidity.length ? ` Liquidity is unreported for ${unknownLiquidity.length} of ${rows.length} holdings; these balances establish neither available liquidity nor lockup.` : ''}${inferredAssetClasses ? ` ${inferredAssetClasses} asset classifications are inferred, not source-confirmed.` : ''}`,
        liquidityCoverage: {
          knownHoldingCount: rows.length - unknownLiquidity.length,
          totalHoldingCount: rows.length,
          complete: unknownLiquidity.length === 0,
          unknownHoldingIds: unknownLiquidity.map((h) => h.id),
        },
        coverage: {
          knownHoldingCount: known.length,
          totalHoldingCount: rows.length,
          complete,
          unknownHoldingIds: rows
            .filter((h) => h[status] === 'unknown')
            .map((h) => h.id),
        },
        asOfDate:
          known
            .map((h) => h.valuationDate)
            .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
            .sort()
            .at(-1) ?? null,
      },
    ];
  });
}
