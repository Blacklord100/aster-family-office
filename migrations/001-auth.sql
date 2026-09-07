-- Better Auth 1.7.3 native PostgreSQL schema. Keep quoted camelCase columns
-- aligned with its adapter; app tables deliberately use snake_case separately.
CREATE TABLE IF NOT EXISTS auth_user (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "twoFactorEnabled" boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_user_email_casefold ON auth_user (lower(email));

CREATE TABLE IF NOT EXISTS auth_session (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  "mfaVerifiedAt" timestamptz
);
CREATE INDEX IF NOT EXISTS auth_session_user ON auth_session ("userId");
CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_session ("expiresAt");

CREATE TABLE IF NOT EXISTS auth_account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("providerId", "accountId")
);
CREATE INDEX IF NOT EXISTS auth_account_user ON auth_account ("userId");

CREATE TABLE IF NOT EXISTS auth_verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_verification_identifier ON auth_verification (identifier);
CREATE INDEX IF NOT EXISTS auth_verification_expiry ON auth_verification ("expiresAt");

CREATE TABLE IF NOT EXISTS auth_two_factor (
  id text PRIMARY KEY,
  secret text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId" text NOT NULL UNIQUE REFERENCES auth_user(id) ON DELETE CASCADE,
  verified boolean NOT NULL DEFAULT true,
  "failedVerificationCount" integer NOT NULL DEFAULT 0,
  "lockedUntil" timestamptz
);
CREATE INDEX IF NOT EXISTS auth_two_factor_secret ON auth_two_factor (secret);

CREATE TABLE IF NOT EXISTS auth_rate_limit (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  "lastRequest" bigint NOT NULL
);

-- Invitations contain only token digests. The organization FK is added after
-- app_organizations exists in 002-app.sql. Raw links exist only at creation.
CREATE TABLE IF NOT EXISTS auth_invitation (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_invitation_organization ON auth_invitation (organization_id);
CREATE INDEX IF NOT EXISTS auth_invitation_expiry ON auth_invitation (expires_at);
