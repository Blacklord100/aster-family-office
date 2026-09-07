'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useState, type SubmitEvent } from 'react';
import {
  ArrowRight,
  Check,
  Loader2,
  LogOut,
  Monitor,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import {
  AuthNotice,
  fieldClass,
  primaryClass,
  secondaryClass,
} from './auth-frame';

export type SessionSummary = {
  id: string;
  token: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  userAgent?: string | null;
  ipAddress?: string | null;
};
type Setup = { qr: string; key: string; codes: string[] };

export function AccountSecurity({
  user,
  initialEnabled,
  initialVerified,
  currentSessionId,
  requireMFA,
  initialSessions,
}: {
  user: { name: string; email: string };
  initialEnabled: boolean;
  initialVerified: boolean;
  currentSessionId: string;
  requireMFA: boolean;
  initialSessions: SessionSummary[];
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [verified, setVerified] = useState(initialVerified);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [savedCodes, setSavedCodes] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>(initialSessions);
  const [sessionsReady, setSessionsReady] = useState(true);

  async function loadSessions() {
    setSessionsReady(false);
    try {
      const result = await authClient.listSessions();
      if (result.error) {
        setError(result.error.message || 'Unable to load your sessions.');
        return;
      }
      setSessions(result.data || []);
    } catch {
      setError('Unable to load your sessions. Please try again.');
    } finally {
      setSessionsReady(true);
    }
  }

  async function beginEnrollment(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy('enroll');
    setError('');
    setNotice('');
    try {
      const result = await authClient.twoFactor.enable({
        password,
        method: 'totp',
      });
      if (result.error) {
        setError(
          result.error.message || 'Unable to start authenticator setup.',
        );
        return;
      }
      setPassword('');
      if (!result.data || !('totpURI' in result.data)) {
        setError(
          'Authenticator setup did not return a setup key. Please try again.',
        );
        return;
      }
      const data = result.data;
      const key = new URL(data.totpURI).searchParams.get('secret') || '';
      setSetup({ qr: '', key, codes: data.backupCodes });
      // The QR is generated locally. No authenticator secret leaves Aster.
      const qr = await import('qrcode');
      const image = await qr.toDataURL(data.totpURI, {
        width: 208,
        margin: 1,
        errorCorrectionLevel: 'M',
      });
      setSetup({ qr: image, key, codes: data.backupCodes });
    } catch {
      setError(
        'Setup could not be completed. If a setup key is shown below, enter it manually in your authenticator.',
      );
    } finally {
      setBusy('');
    }
  }

  async function verifyFactor(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy('verify');
    setError('');
    setNotice('');
    try {
      const result =
        recovery && !setup
          ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
          : await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (result.error) {
        setError(result.error.message || 'The code could not be verified.');
        return;
      }
      // A successful second-factor endpoint stamps this session on the server.
      setEnabled(true);
      setVerified(true);
      setSetup(null);
      setCode('');
      window.location.assign('/');
    } catch {
      setError('Unable to verify your code. Please try again.');
    } finally {
      setBusy('');
    }
  }

  async function signOut() {
    if (busy) return;
    setBusy('sign-out');
    setError('');
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError(result.error.message || 'Unable to sign out.');
        return;
      }
      setSetup(null);
      setPassword('');
      setCode('');
      window.location.assign('/login');
    } catch {
      setError('Unable to sign out. Please try again.');
    } finally {
      setBusy('');
    }
  }

  async function revoke(session: SessionSummary) {
    if (busy) return;
    setBusy(session.id);
    setError('');
    setNotice('');
    try {
      const result = await authClient.revokeSession({ token: session.token });
      if (result.error) {
        setError(result.error.message || 'Unable to revoke this session.');
        return;
      }
      if (session.id === currentSessionId) {
        window.location.assign('/login');
        return;
      }
      setSessions((current) =>
        current.filter((item) => item.id !== session.id),
      );
      setNotice('The session has been signed out.');
    } catch {
      setError('Unable to revoke this session. Please try again.');
    } finally {
      setBusy('');
    }
  }

  async function changePassword(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy('password');
    setError('');
    setNotice('');
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError(result.error.message || 'Unable to change your password.');
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      // Better Auth rotates the session and revokes the rest. The replacement
      // requires its own MFA proof; reload its server-derived security state.
      window.location.assign('/account');
    } catch {
      setError('Unable to change your password. Please try again.');
    } finally {
      setBusy('');
    }
  }

  const canOpenWorkspace = verified || !requireMFA;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-white p-5">
        <div>
          <p className="font-medium">{user.name}</p>
          <p className="mt-1 text-xs text-muted-foreground">{user.email}</p>
        </div>
        <button
          className={secondaryClass}
          disabled={Boolean(busy)}
          onClick={signOut}
        >
          <LogOut className="size-3.5" />
          Sign out
        </button>
      </div>
      {error ? <AuthNotice>{error}</AuthNotice> : null}
      {notice ? <AuthNotice success>{notice}</AuthNotice> : null}

      <section
        className="rounded-xl border border-border bg-white p-5 sm:p-6"
        aria-labelledby="authenticator-title"
      >
        <div className="flex items-start gap-3">
          <span
            className={`rounded-lg p-2 ${verified ? 'bg-emerald-50 text-emerald-600' : 'bg-accent text-primary'}`}
          >
            <ShieldCheck className="size-5" />
          </span>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="authenticator-title" className="font-medium">
                Two-factor authentication
              </h2>
              {verified ? (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                  Verified this session
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {verified
                ? 'Your authenticator protects access to your workspace.'
                : enabled
                  ? 'Verify your authenticator to finish securing this session.'
                  : requireMFA
                    ? 'Set up an authenticator to open your workspace.'
                    : 'Add an authenticator for another layer of account protection.'}
            </p>
          </div>
        </div>

        {!enabled && !setup ? (
          <form onSubmit={beginEnrollment} className="mt-6 max-w-sm space-y-3">
            <label
              htmlFor="enroll-password"
              className="block text-xs font-medium"
            >
              Confirm your password
            </label>
            <input
              id="enroll-password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              className={fieldClass}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={Boolean(busy)}
            />
            <button
              className={primaryClass}
              disabled={Boolean(busy)}
              type="submit"
            >
              {busy === 'enroll' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Smartphone className="size-4" />
              )}
              Set up authenticator
            </button>
          </form>
        ) : null}

        {setup ? (
          <div className="mt-6 space-y-6">
            <div className="rounded-lg border border-border bg-[#fafafa] p-4">
              <h3 className="text-sm font-medium">
                1. Add Aster to your authenticator
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Scan this code with your authenticator app.
              </p>
              <div className="mt-4 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
                {setup.qr ? (
                  <Image
                    unoptimized
                    src={setup.qr}
                    alt="Scan this QR code to set up your Aster authenticator"
                    width={208}
                    height={208}
                    className="rounded-md border border-border bg-white p-2"
                  />
                ) : (
                  <div className="flex size-52 items-center justify-center rounded-md border border-border bg-white text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                )}
                <details className="max-w-full text-xs">
                  <summary className="cursor-pointer text-primary">
                    Enter a setup key manually
                  </summary>
                  <p className="mt-3 max-w-xs break-all rounded border border-border bg-white p-3 font-mono leading-6">
                    {setup.key}
                  </p>
                  <p className="mt-2 leading-5 text-muted-foreground">
                    Choose a time-based code.
                  </p>
                </details>
              </div>
            </div>
            <div>
              <h3 className="text-sm font-medium">
                2. Save your recovery codes
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Keep these in a safe place. Each code works once if you lose
                your authenticator. They are shown during this setup only.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 rounded-lg border border-border bg-[#fafafa] p-4 font-mono text-xs sm:grid-cols-5">
                {setup.codes.map((item) => (
                  <code key={item}>{item}</code>
                ))}
              </div>
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={savedCodes}
                  onChange={(event) => setSavedCodes(event.target.checked)}
                  className="size-3.5 accent-primary"
                />
                I have saved my recovery codes
              </label>
            </div>
          </div>
        ) : null}

        {setup || (enabled && !verified) ? (
          <form onSubmit={verifyFactor} className="mt-6 max-w-sm space-y-3">
            <h3 className="text-sm font-medium">
              {setup ? '3. Verify your authenticator' : 'Verify this session'}
            </h3>
            <label
              htmlFor="account-code"
              className="block text-xs text-muted-foreground"
            >
              {recovery && !setup
                ? 'Enter a saved recovery code'
                : 'Enter the six-digit code from your authenticator'}
            </label>
            <input
              id="account-code"
              key={recovery ? 'recovery' : 'totp'}
              autoComplete="one-time-code"
              inputMode={recovery && !setup ? 'text' : 'numeric'}
              pattern={recovery && !setup ? undefined : '[0-9]{6}'}
              maxLength={recovery && !setup ? 30 : 6}
              required
              className={`${fieldClass} font-mono`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={Boolean(busy)}
            />
            <button
              className={primaryClass}
              disabled={Boolean(busy) || Boolean(setup && !savedCodes)}
              type="submit"
            >
              {busy === 'verify' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Verify and open workspace
            </button>
            {!setup ? (
              <button
                type="button"
                className="block pt-1 text-xs text-primary hover:underline"
                disabled={Boolean(busy)}
                onClick={() => {
                  setRecovery(!recovery);
                  setCode('');
                  setError('');
                }}
              >
                {recovery ? 'Use authenticator instead' : 'Use a recovery code'}
              </button>
            ) : null}
          </form>
        ) : null}
      </section>

      {verified || !enabled ? (
        <section
          className="rounded-xl border border-border bg-white p-5 sm:p-6"
          aria-labelledby="password-title"
        >
          <h2 id="password-title" className="font-medium">
            Change password
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Other devices will be signed out.{' '}
            {enabled
              ? 'You’ll verify your authenticator again.'
              : 'Use a unique passphrase of at least 15 characters.'}
          </p>
          <form onSubmit={changePassword} className="mt-5 max-w-sm space-y-3">
            <div className="space-y-2">
              <label
                className="block text-xs font-medium"
                htmlFor="current-password"
              >
                Current password
              </label>
              <input
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                className={fieldClass}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={Boolean(busy)}
              />
            </div>
            <div className="space-y-2">
              <label
                className="block text-xs font-medium"
                htmlFor="new-password"
              >
                New password
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={15}
                maxLength={128}
                className={fieldClass}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={Boolean(busy)}
              />
            </div>
            <div className="space-y-2">
              <label
                className="block text-xs font-medium"
                htmlFor="confirm-password"
              >
                Confirm new password
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={15}
                maxLength={128}
                className={fieldClass}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={Boolean(busy)}
              />
            </div>
            <button
              className={primaryClass}
              type="submit"
              disabled={Boolean(busy)}
            >
              {busy === 'password' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Update password
            </button>
          </form>
        </section>
      ) : null}

      <section
        className="rounded-xl border border-border bg-white p-5 sm:p-6"
        aria-labelledby="sessions-title"
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h2 id="sessions-title" className="font-medium">
              Your sessions
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Sign out a device you no longer use. Sessions expire after eight
              hours.
            </p>
          </div>
          <button
            className="text-xs text-primary hover:underline"
            onClick={() => void loadSessions()}
            disabled={Boolean(busy)}
          >
            Refresh
          </button>
        </div>
        {!sessionsReady ? (
          <output className="text-xs text-muted-foreground">
            Loading sessions…
          </output>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No active sessions found.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {sessions.map((session) => (
              <div
                key={session.id}
                data-session-id={session.id}
                className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0"
              >
                <span className="rounded-lg bg-muted p-2 text-muted-foreground">
                  <Monitor className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-medium">
                      {deviceLabel(session.userAgent)}
                    </p>
                    {session.id === currentSessionId ? (
                      <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground">
                        This device
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                    Signed in{' '}
                    {new Date(session.createdAt).toLocaleString('en-GB', {
                      timeZone: 'UTC',
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    UTC
                    {session.ipAddress ? ` · ${session.ipAddress}` : ''}
                  </p>
                </div>
                <button
                  className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
                  disabled={Boolean(busy)}
                  onClick={() => void revoke(session)}
                >
                  {busy === session.id ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      {canOpenWorkspace ? (
        <div className="flex justify-end">
          <Link href="/" className={primaryClass}>
            Open workspace
            <ArrowRight className="size-4" />
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function deviceLabel(agent?: string | null): string {
  if (!agent) return 'Browser session';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Chrome\//.test(agent)
      ? 'Chrome'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Browser';
  const device = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Macintosh/.test(agent)
        ? 'Mac'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return device ? `${browser} on ${device}` : browser;
}
