'use client';

import { useState, type SubmitEvent } from 'react';
import { ArrowRight, Loader2, ShieldCheck } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { AuthNotice, fieldClass, primaryClass } from './auth-frame';

export function LoginForm() {
  const [step, setStep] = useState<'password' | 'factor'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (step === 'password') {
        const result = await authClient.signIn.email({
          email: email.trim(),
          password,
        });
        if (result.error) {
          setError(
            result.error.message ||
              'Unable to sign in. Check your email and password.',
          );
          return;
        }
        setPassword('');
        if (
          result.data &&
          'twoFactorRedirect' in result.data &&
          result.data.twoFactorRedirect
        ) {
          setStep('factor');
          return;
        }
        window.location.assign('/account');
      } else {
        const result = recovery
          ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
          : await authClient.twoFactor.verifyTotp({ code: code.trim() });
        if (result.error) {
          setError(
            result.error.message ||
              'The code could not be verified. Try again.',
          );
          return;
        }
        setCode('');
        window.location.assign('/');
      }
    } catch {
      setError('Unable to reach Aster. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-white p-6 shadow-[0_2px_8px_#00000003]">
      {step === 'factor' ? (
        <div className="mb-6 flex items-start gap-3">
          <span className="rounded-lg bg-accent p-2 text-primary">
            <ShieldCheck className="size-5" />
          </span>
          <div>
            <h2 className="font-medium">Verify it’s you</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {recovery
                ? 'Enter one of your saved recovery codes. Each code can be used once.'
                : 'Enter the six-digit code from your authenticator app.'}
            </p>
          </div>
        </div>
      ) : null}
      <form onSubmit={submit} className="space-y-4">
        {step === 'password' ? (
          <>
            <div className="space-y-2">
              <label
                className="block text-xs font-medium"
                htmlFor="login-email"
              >
                Email address
              </label>
              <input
                id="login-email"
                name="email"
                className={fieldClass}
                type="email"
                autoComplete="username"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@yourfamilyoffice.com"
                disabled={busy}
              />
            </div>
            <div className="space-y-2">
              <label
                className="block text-xs font-medium"
                htmlFor="login-password"
              >
                Password
              </label>
              <input
                id="login-password"
                name="password"
                className={fieldClass}
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <label className="block text-xs font-medium" htmlFor="login-code">
              {recovery ? 'Recovery code' : 'Authenticator code'}
            </label>
            <input
              key={recovery ? 'recovery' : 'totp'}
              id="login-code"
              className={`${fieldClass} font-mono ${recovery ? '' : 'text-center text-lg tracking-[0.3em]'}`}
              autoComplete="one-time-code"
              inputMode={recovery ? 'text' : 'numeric'}
              pattern={recovery ? undefined : '[0-9]{6}'}
              maxLength={recovery ? 30 : 6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={busy}
            />
          </div>
        )}
        {error ? <AuthNotice>{error}</AuthNotice> : null}
        <button
          className={`${primaryClass} w-full`}
          disabled={busy}
          type="submit"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {step === 'password' ? 'Sign in' : 'Verify and continue'}
          {!busy ? <ArrowRight className="size-4" /> : null}
        </button>
      </form>
      {step === 'factor' ? (
        <div className="mt-5 flex flex-wrap justify-between gap-3 text-xs">
          <button
            disabled={busy}
            className="text-primary hover:underline"
            onClick={() => {
              setRecovery(!recovery);
              setCode('');
              setError('');
            }}
          >
            {recovery ? 'Use authenticator instead' : 'Use a recovery code'}
          </button>
          <button
            disabled={busy}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => {
              setStep('password');
              setCode('');
              setError('');
            }}
          >
            Back to sign in
          </button>
        </div>
      ) : (
        <p className="mt-5 text-xs leading-5 text-muted-foreground">
          Access is by invitation. Contact your workspace owner if you need an
          account or help signing in.
        </p>
      )}
    </div>
  );
}
