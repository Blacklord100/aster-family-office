'use client';
import { useEffect, useState, type SubmitEvent } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';
import { AuthNotice, fieldClass, primaryClass } from './auth-frame';
export function PasswordRecovery({
  reset = false,
  enabled = false,
}: {
  reset?: boolean;
  enabled?: boolean;
}) {
  const [token, setToken] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState(''),
    [done, setDone] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (reset) {
      const value = new URLSearchParams(window.location.hash.slice(1)).get(
        'token',
      );
      if (value) {
        // oxlint-disable-next-line react/react-compiler -- Synchronize the browser-only reset fragment once before removing it from the URL.
        setToken(value);
        window.history.replaceState(null, '', window.location.pathname);
      }
    }
  }, [reset]);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (reset && password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const result = reset
        ? await authClient.resetPassword({ token, newPassword: password })
        : await authClient.requestPasswordReset({
            email: email.trim(),
            redirectTo: window.location.origin + '/reset-password',
          });
      if (result.error) {
        setError(
          reset
            ? 'This link is invalid or expired. Request a new reset link.'
            : 'The request could not be completed. Try again shortly.',
        );
        return;
      }
      setPassword('');
      setConfirmation('');
      setToken('');
      setDone(true);
    } catch {
      setError('Unable to reach Aster. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5 rounded-xl border bg-white p-6">
      {done ? (
        <AuthNotice success>
          {reset
            ? 'Your password has been reset. Sign in and verify your authenticator.'
            : 'If this address has an eligible account, a reset link will be delivered. Check your inbox.'}
        </AuthNotice>
      ) : !reset && !enabled ? (
        <p className="text-sm leading-6">
          Password-reset delivery is not configured for this installation.
          Contact your workspace administrator. Your authenticator recovery
          codes remain available for a lost authenticator.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {reset ? (
            <>
              <p className="text-xs text-muted-foreground">
                Use 15–128 characters. Resetting your password revokes existing
                sessions and keeps your authenticator enabled.
              </p>
              <label className="block text-sm">
                New password
                <input
                  className={fieldClass}
                  aria-label="New password"
                  autoComplete="new-password"
                  type="password"
                  minLength={15}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              <label className="block text-sm">
                Confirm password
                <input
                  className={fieldClass}
                  aria-label="Confirm password"
                  autoComplete="new-password"
                  type="password"
                  minLength={15}
                  maxLength={128}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  required
                />
              </label>
              {!token ? (
                <AuthNotice>
                  Open the complete reset link from your email. Reloading this
                  page clears its one-time token.
                </AuthNotice>
              ) : null}
            </>
          ) : (
            <label className="block text-sm">
              Email address
              <input
                className={fieldClass}
                aria-label="Recovery email"
                autoComplete="email"
                type="email"
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
          )}
          {error ? <AuthNotice>{error}</AuthNotice> : null}
          <button
            className={primaryClass + ' w-full'}
            disabled={busy || (reset && !token)}
          >
            {busy
              ? 'Working…'
              : reset
                ? 'Reset password'
                : 'Request reset link'}
          </button>
        </form>
      )}
      <Link href="/login" className="text-sm text-primary underline">
        Back to sign in
      </Link>
    </div>
  );
}
