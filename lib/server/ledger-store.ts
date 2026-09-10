import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  ledgerRequestSchema,
  emptyFinanceState,
  type LedgerRequest,
  type LedgerResponse,
} from '../ledger-contract';
import { applyLedgerAction, LedgerError } from '../ledger';
import { deriveWorkspace } from '../workspace';
import {
  readWorkspace,
  readWorkspaceInTransaction,
  saveWorkspace,
} from '../workspace-store';
import { AccessError, roleAllows, type WorkspaceContext } from './access';
import { withTenant } from './db';
import { audit } from './audit';
import { sha256 } from './crypto';

export async function readLedger(
  ctx: WorkspaceContext,
): Promise<LedgerResponse> {
  // readWorkspace applies family/entity scope before these financial records are returned.
  const { state, revision } = await readWorkspace(ctx);
  const data = deriveWorkspace(state);
  return {
    finance: state.finance ?? emptyFinanceState(),
    portfolio: {
      holdings: data.holdings,
      history: data.history,
      events: data.events,
      evidence: data.evidence,
      tasks: data.tasks,
      families: data.families,
      entities: data.entities,
      accounts: data.accounts,
    },
    revision,
    canWrite: roleAllows(ctx.role, 'write') && !ctx.scope,
  };
}
export async function writeLedger(
  ctx: WorkspaceContext,
  value: LedgerRequest,
): Promise<LedgerResponse> {
  if (!roleAllows(ctx.role, 'write') || ctx.scope)
    throw new AccessError(
      403,
      'FORBIDDEN',
      'You do not have permission to change this ledger.',
    );
  const input = ledgerRequestSchema.parse(value);
  const digest = sha256(JSON.stringify(input.command));
  try {
    return await withTenant(ctx.organizationId, async (client) => {
      const { state, revision } = await readWorkspaceInTransaction(
        client,
        ctx.organizationId,
        true,
      );
      const finance = state.finance ?? emptyFinanceState();
      const previous = finance.receipts.find(
        (item) => item.key === input.idempotencyKey,
      );
      const derived = deriveWorkspace(state);
      const portfolio = {
        holdings: derived.holdings,
        history: derived.history,
        events: derived.events,
        evidence: derived.evidence,
        tasks: derived.tasks,
        families: derived.families,
        entities: derived.entities,
        accounts: derived.accounts,
      };
      if (previous) {
        if (previous.digest !== digest)
          throw new AccessError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This request key was already used for different financial instructions.',
          );
        return {
          finance,
          portfolio,
          revision,
          canWrite: true,
          resultId: previous.resultId,
          duplicate: true,
        };
      }
      if (revision !== input.expectedRevision)
        throw new AccessError(
          409,
          'LEDGER_CHANGED',
          'The workspace changed. Reload the register and review the latest balances before submitting again.',
        );
      if (finance.receipts.length >= 5000)
        throw new AccessError(
          409,
          'LEDGER_LIMIT',
          'This workspace has reached its bounded ledger request limit.',
        );
      const at = new Date().toISOString();
      const next = applyLedgerAction(portfolio, finance, input.command, {
        id: randomUUID(),
        actorId: ctx.user.id,
        at,
      });
      next.finance.receipts.push({
        key: input.idempotencyKey,
        digest,
        resultId: next.resultId,
        at,
      });
      await saveWorkspace(client, ctx.organizationId, {
        ...state,
        portfolio: next.portfolio,
        finance: next.finance,
      });
      await audit(
        client,
        ctx.organizationId,
        ctx.user.id,
        'ledger.' + input.command.type,
        next.resultId,
        {
          financeRevision: next.finance.revision,
          ...('obligationId' in input.command
            ? { obligationId: input.command.obligationId }
            : {}),
          ...('transactionId' in input.command
            ? { transactionId: input.command.transactionId }
            : {}),
        },
      );
      return { ...next, revision: revision + 1, canWrite: true };
    });
  } catch (error) {
    if (error instanceof LedgerError)
      throw new AccessError(error.status, error.code, error.message);
    throw error;
  }
}
