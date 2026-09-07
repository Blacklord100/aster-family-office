'use client';

import Link from 'next/link';
import { useEffect, useState, type SubmitEvent } from 'react';
import { ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { AuthNotice, fieldClass, primaryClass } from './auth-frame';

export function InviteForm() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState('');

  useEffect(() => {
    const url = new URL(window.location.href);
    const value =
      new URLSearchParams(url.hash.slice(1)).get('token') ||
      url.searchParams.get('token') ||
      '';
    // oxlint-disable-next-line react/react-compiler -- Capture the client-only bearer fragment once before removing it from browser history.
    setToken((current) => current ?? value);
    if (value) window.history.replaceState(null, '', '/invite');
  }, []);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/invitations', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.message || 'This invitation could not be accepted.');
        return;
      }
      setAccepted(result.email);
      setPassword('');
      setConfirmation('');
      setToken('');
    } catch {
      setError('Unable to reach Aster. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (token === null)
    return (
      <output className="text-sm text-muted-foreground">
        Opening your invitation…
      </output>
    );
  if (accepted)
    return (
      <div className="space-y-5 rounded-xl border border-border bg-white p-6">
        <CheckCircle2 className="size-8 text-emerald-600" />
        <div>
          <h2 className="font-medium">Your account is ready</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Sign in as {accepted}, then set up your authenticator.
          </p>
        </div>
        <Link className={`${primaryClass} w-full`} href="/login">
          Continue to sign in
          <ArrowRight className="size-4" />
        </Link>
      </div>
    );
  if (!token)
    return (
      <div className="space-y-4 rounded-xl border border-border bg-white p-6">
        <AuthNotice>
          Open the complete invitation link from your workspace owner. If you
          have already accepted it, sign in below.
        </AuthNotice>
        <Link href="/login" className="text-sm text-primary hover:underline">
          Go to sign in
        </Link>
      </div>
    );
  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-xl border border-border bg-white p-6"
    >
      <p className="pb-1 text-sm leading-6 text-muted-foreground">
        Choose a password to accept your invitation. A long, unique passphrase
        works well.
      </p>
      <div className="space-y-2">
        <label htmlFor="invite-password" className="block text-xs font-medium">
          New password
        </label>
        <input
          id="invite-password"
          type="password"
          autoComplete="new-password"
          minLength={15}
          maxLength={128}
          required
          className={fieldClass}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
        />
        <p className="text-xs text-muted-foreground">15–128 characters</p>
      </div>
      <div className="space-y-2">
        <label htmlFor="invite-confirm" className="block text-xs font-medium">
          Confirm password
        </label>
        <input
          id="invite-confirm"
          type="password"
          autoComplete="new-password"
          minLength={15}
          maxLength={128}
          required
          className={fieldClass}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          disabled={busy}
        />
      </div>
      {error ? <AuthNotice>{error}</AuthNotice> : null}
      <button
        className={`${primaryClass} w-full`}
        type="submit"
        disabled={busy}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}Accept
        invitation
        <ArrowRight className="size-4" />
      </button>
      <p className="text-xs leading-5 text-muted-foreground">
        Invitation links expire after 24 hours and can be used once.
      </p>
    </form>
  );
}
