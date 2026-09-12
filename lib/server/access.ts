import 'server-only';
import { lifecycleDatabaseError, lifecycleResponse } from './lifecycle';
import { auth, authEnvironment, mfaRequired } from './auth';
import { isOrganizationId, pool } from './db';
import { DataScopeSchema, type DataScope } from '../data-scope';

export type WorkspaceRole = 'owner' | 'admin' | 'analyst' | 'viewer';
export interface WorkspaceContext {
  user: { id: string; email: string; name: string };
  organizationId: string;
  role: WorkspaceRole;
  sessionId: string;
  scope?: DataScope | null;
  /** A read recovered from a stale cookie; the workspace GET clears it. */
  staleWorkspaceSelection?: true;
}

export class AccessError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export function errorResponse(error: unknown): Response {
  if (lifecycleDatabaseError(error)) return lifecycleResponse(error);
  const known = error instanceof AccessError;
  return Response.json(
    {
      error: known ? error.code : 'INTERNAL_ERROR',
      message: known
        ? error.message
        : 'The request could not be completed. Please try again.',
    },
    {
      status: known ? error.status : 500,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

/** Browser mutations must carry an exact configured Origin, never a proxy Host. */
export function assertSameOrigin(request: Request): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return;
  const origin = request.headers.get('origin');
  if (
    !origin ||
    origin !== authEnvironment().origin ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    throw new AccessError(
      403,
      'INVALID_ORIGIN',
      'Reload Aster from its configured address and try again.',
    );
  }
}

export function roleAllows(
  role: string,
  permission: 'read' | 'write' | 'admin',
): boolean {
  if (!['owner', 'admin', 'analyst', 'viewer'].includes(role)) return false;
  if (permission === 'admin') return role === 'owner' || role === 'admin';
  if (permission === 'write') return role !== 'viewer';
  return permission === 'read';
}

export async function requireWorkspace(
  request: Request,
  permission: 'read' | 'write' | 'admin' = 'read',
): Promise<WorkspaceContext> {
  assertSameOrigin(request);
  const current = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!current)
    throw new AccessError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  // Explicit organization headers fail closed. Stale browser selections may
  // recover on reads, but must never silently redirect a write to another office.
  const explicit = request.headers.get('x-aster-organization');
  const cookieWorkspace = selectedWorkspaceCookie(request);
  if (explicit !== null && !isOrganizationId(explicit))
    throw new AccessError(
      400,
      'INVALID_ORGANIZATION',
      'Choose a valid workspace.',
    );
  const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(
    request.method.toUpperCase(),
  );
  let staleWorkspaceSelection =
    explicit === null &&
    cookieWorkspace !== null &&
    !isOrganizationId(cookieWorkspace);
  if (staleWorkspaceSelection && !readOnly)
    throw new AccessError(
      409,
      'WORKSPACE_SELECTION_CHANGED',
      'Reload Aster before changing records; your previous workspace selection is no longer available.',
    );
  const requested =
    explicit ?? (staleWorkspaceSelection ? null : cookieWorkspace);
  const membershipQuery = (organizationId: string | null) =>
    pool.query<{
      organization_id: string;
      role: string;
      data_scope?: unknown;
    }>(
      `SELECT organization_id, role, data_scope FROM app_memberships WHERE user_id = $1 AND revoked_at IS NULL
     ${organizationId ? 'AND organization_id = $2' : ''} ORDER BY (SELECT demo_owner_user_id IS NOT NULL FROM app_organizations WHERE id=organization_id), created_at, organization_id LIMIT 1`,
      organizationId ? [current.user.id, organizationId] : [current.user.id],
    );
  let membership = (await membershipQuery(requested)).rows[0];
  if (!membership && explicit === null && requested !== null) {
    if (!readOnly)
      throw new AccessError(
        409,
        'WORKSPACE_SELECTION_CHANGED',
        'Reload Aster before changing records; your previous workspace selection is no longer available.',
      );
    staleWorkspaceSelection = true;
    membership = (await membershipQuery(null)).rows[0];
  }
  if (!membership || !roleAllows(membership.role, permission))
    throw new AccessError(
      403,
      'FORBIDDEN',
      'You do not have access to this workspace or action.',
    );
  if (
    mfaRequired() &&
    (!current.user.twoFactorEnabled || !current.session.mfaVerifiedAt)
  ) {
    throw new AccessError(
      403,
      'MFA_REQUIRED',
      'Set up or verify your authenticator in Account security to open this workspace.',
    );
  }
  const scope =
    membership.data_scope == null
      ? null
      : DataScopeSchema.parse(membership.data_scope);
  if (scope) {
    const path = new URL(request.url).pathname;
    const readable =
      request.method === 'GET' &&
      ([
        '/api/workspace',
        '/api/ledger',
        '/api/portfolio-history',
        '/api/participation',
        '/api/reporting',
        '/api/report-obligations',
      ].includes(path) ||
        /^\/api\/archive\/documents\/[a-f0-9-]{36}$/i.test(path) ||
        /^\/api\/documents\/[a-f0-9-]{36}(?:\/preview|\/email(?:\/attachments\/\d{1,2})?)?$/i.test(
          path,
        ));
    const question =
      request.method === 'POST' && path === '/api/intelligence/ask';
    if (
      membership.role !== 'viewer' ||
      permission !== 'read' ||
      (!readable && !question)
    )
      throw new AccessError(
        403,
        'SCOPED_ACCESS',
        'This account has read-only access to selected family records.',
      );
  }
  return {
    user: {
      id: current.user.id,
      email: current.user.email,
      name: current.user.name,
    },
    organizationId: membership.organization_id,
    role: membership.role as WorkspaceRole,
    sessionId: current.session.id,
    scope,
    ...(staleWorkspaceSelection
      ? { staleWorkspaceSelection: true as const }
      : {}),
  };
}

export function selectedWorkspaceCookie(request: Request): string | null {
  return (
    request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('aster_workspace='))
      ?.slice('aster_workspace='.length) ?? null
  );
}
export function clearStaleWorkspaceCookie(
  response: Response,
  context: WorkspaceContext,
): Response {
  if (context.staleWorkspaceSelection)
    response.headers.append(
      'Set-Cookie',
      'aster_workspace=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' +
        (new URL(authEnvironment().origin).protocol === 'https:'
          ? '; Secure'
          : ''),
    );
  return response;
}
