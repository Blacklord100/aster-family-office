import 'server-only';
import { betterAuth } from 'better-auth';
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { assertDatabaseRole, pool } from './db';

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
export const MFA_VERIFY_PATHS = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
]);

export function passwordPolicyError(password: unknown): string | null {
  if (
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    return `Use a password or passphrase between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (
    /^([\s\S])\1+$/u.test(password) ||
    /^(password|qwerty|1234567890|letmein|administrator)[\d\W]*$/i.test(
      password,
    )
  ) {
    return 'Choose a less predictable password or passphrase.';
  }
  return null;
}

export function mfaRequired(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.AUTH_REQUIRE_MFA === 'true'
  );
}

export function authEnvironment() {
  const secret = process.env.BETTER_AUTH_SECRET;
  const normalizedSecret = secret?.trim().toLowerCase();
  if (
    !secret ||
    secret.length < 32 ||
    new Set(secret).size < 12 ||
    /^(replace(?:[\s_-]|$)|change[\s_-]*me(?:[\s_-]|$)|todo(?:[\s_-]|$))/i.test(
      normalizedSecret ?? '',
    ) ||
    normalizedSecret === 'better-auth-secret-12345678901234567890'
  ) {
    throw new Error(
      'BETTER_AUTH_SECRET must contain at least 32 random characters and cannot be an example or default value. Generate one with openssl rand -base64 32.',
    );
  }
  const value = process.env.BETTER_AUTH_URL;
  if (!value)
    throw new Error(
      'BETTER_AUTH_URL is required and must be the exact public origin.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('BETTER_AUTH_URL must be a valid HTTP(S) origin.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'BETTER_AUTH_URL must be an HTTP(S) origin without a path, query, or credentials.',
    );
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('BETTER_AUTH_URL must use HTTPS in production.');
  }
  return {
    secret,
    origin: url.origin,
    secure: process.env.NODE_ENV === 'production' || url.protocol === 'https:',
  };
}

export function createAsterAuth() {
  const env = authEnvironment();
  return betterAuth({
    appName: 'Aster',
    baseURL: env.origin,
    basePath: '/api/auth',
    secret: env.secret,
    // Driver errors can contain query values. Application health and HTTP
    // status monitoring remain available without raw authentication logs.
    logger: { disabled: true },
    database: pool,
    trustedOrigins: [env.origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      requireEmailVerification: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      revokeSessionsOnPasswordReset: true,
      // Password-reset mail is intentionally unavailable until a delivery
      // provider is configured. No reset token is logged or returned publicly.
    },
    user: {
      modelName: 'auth_user',
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    account: { modelName: 'auth_account', accountLinking: { enabled: false } },
    verification: { modelName: 'auth_verification', storeIdentifier: 'hashed' },
    session: {
      modelName: 'auth_session',
      expiresIn: 8 * 60 * 60,
      freshAge: 15 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        mfaVerifiedAt: { type: 'date', required: false, input: false },
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'auth_rate_limit',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/two-factor/*': { window: 60, max: 5 },
        '/change-password': { window: 60, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: 'aster',
      useSecureCookies: env.secure,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.secure,
        path: '/',
      },
      ipAddress: {
        ipAddressHeaders: [process.env.AUTH_CLIENT_IP_HEADER || 'x-real-ip'],
      },
    },
    plugins: [
      twoFactor({
        issuer: 'Aster',
        twoFactorTable: 'auth_two_factor',
        skipVerificationOnEnable: false,
        allowPasswordless: false,
        twoFactorCookieMaxAge: 5 * 60,
        backupCodeOptions: { storeBackupCodes: 'encrypted' },
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({
            data: { ...session, mfaVerifiedAt: null },
          }),
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        await assertDatabaseRole();
        if (ctx.body?.trustDevice === true) {
          throw new APIError('BAD_REQUEST', {
            code: 'MFA_TRUST_DISABLED',
            message: 'Verify your second factor for each new session.',
          });
        }
        if (ctx.path === '/two-factor/enable' && ctx.body?.method === 'otp') {
          throw new APIError('BAD_REQUEST', {
            code: 'TOTP_REQUIRED',
            message: 'Set up an authenticator app.',
          });
        }
        if (
          ctx.path === '/request-password-reset' ||
          ctx.path === '/forget-password'
        ) {
          throw new APIError('FORBIDDEN', {
            code: 'RECOVERY_NOT_CONFIGURED',
            message: 'Contact your workspace owner for account recovery.',
          });
        }
        if (
          [
            '/two-factor/disable',
            '/two-factor/get-totp-uri',
            '/two-factor/generate-backup-codes',
            '/change-password',
            '/set-password',
          ].includes(ctx.path)
        ) {
          const current = await getSessionFromCtx(ctx);
          // A password-only session left over from enrollment cannot read the
          // authenticator secret or disable the newly enabled second factor.
          if (
            current?.user.twoFactorEnabled &&
            !current.session.mfaVerifiedAt
          ) {
            throw new APIError('FORBIDDEN', {
              code: 'MFA_REQUIRED',
              message:
                'Verify your second factor before changing account security.',
            });
          }
        }
        if (
          ['/change-password', '/reset-password', '/set-password'].includes(
            ctx.path,
          )
        ) {
          const error = passwordPolicyError(
            ctx.body?.newPassword ?? ctx.body?.password,
          );
          if (error)
            throw new APIError('BAD_REQUEST', {
              code: 'WEAK_PASSWORD',
              message: error,
            });
        }
        if (ctx.path === '/change-password') {
          return {
            context: {
              ...ctx,
              body: { ...ctx.body, revokeOtherSessions: true },
            },
          };
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.context.returned instanceof APIError) return;
        if (ctx.path === '/two-factor/disable') {
          const current = ctx.context.newSession ?? ctx.context.session;
          if (current)
            await pool.query(
              'DELETE FROM auth_session WHERE "userId" = $1 AND id <> $2',
              [current.user.id, current.session.id],
            );
          return;
        }
        if (!MFA_VERIFY_PATHS.has(ctx.path)) return;
        const returned = ctx.context.returned as {
          token?: unknown;
          user?: { id?: string };
        } | null;
        if (
          !returned ||
          typeof returned.token !== 'string' ||
          !returned.user?.id
        )
          return;
        // Enrollment rotates its session, while re-verification retains it.
        // newSession is authoritative when present; the response token is a
        // fallback only for successful re-verification of an existing session.
        const token = ctx.context.newSession?.session.token ?? returned.token;
        await pool.query(
          `UPDATE auth_session s SET "mfaVerifiedAt" = CURRENT_TIMESTAMP
           FROM auth_user u, auth_two_factor f
           WHERE s.token = $1 AND s."userId" = $2 AND u.id = s."userId"
             AND u."twoFactorEnabled" = true AND f."userId" = u.id AND f.verified = true`,
          [token, returned.user.id],
        );
        if (
          ctx.context.newSession &&
          ctx.context.session?.user.twoFactorEnabled === false
        ) {
          await pool.query(
            'DELETE FROM auth_session WHERE "userId" = $1 AND token <> $2',
            [returned.user.id, token],
          );
        }
      }),
    },
  });
}

type AsterAuth = ReturnType<typeof createAsterAuth>;
let instance: AsterAuth | undefined;
/** Lazy only for builds; first use validates all runtime auth configuration. */
export const auth: AsterAuth = new Proxy({} as AsterAuth, {
  get(_target, property) {
    instance ??= createAsterAuth();
    return Reflect.get(instance, property);
  },
});
