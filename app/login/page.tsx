import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, mfaRequired } from '@/lib/server/auth';
import { AuthFrame } from '@/components/auth/auth-frame';
import { LoginForm } from '@/components/auth/login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
  if (session)
    redirect(
      mfaRequired() &&
        (!session.user.twoFactorEnabled || !session.session.mfaVerifiedAt)
        ? '/account'
        : '/',
    );
  return (
    <AuthFrame
      title="Welcome back"
      description="Sign in to your family office workspace."
    >
      <LoginForm />
    </AuthFrame>
  );
}
