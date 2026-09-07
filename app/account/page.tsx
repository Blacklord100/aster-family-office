import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, mfaRequired } from '@/lib/server/auth';
import { AuthFrame } from '@/components/auth/auth-frame';
import { AccountSecurity } from '@/components/auth/account-security';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  });
  if (!session) redirect('/login');
  const sessions = await auth.api.listSessions({ headers: requestHeaders });
  return (
    <AuthFrame
      wide
      title="Account security"
      description="Manage your authenticator and the devices signed in to Aster."
    >
      <AccountSecurity
        user={{ name: session.user.name, email: session.user.email }}
        initialEnabled={Boolean(session.user.twoFactorEnabled)}
        initialVerified={Boolean(
          session.user.twoFactorEnabled && session.session.mfaVerifiedAt,
        )}
        currentSessionId={session.session.id}
        requireMFA={mfaRequired()}
        initialSessions={sessions.map(
          ({ id, token, createdAt, expiresAt, userAgent, ipAddress }) => ({
            id,
            token,
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            userAgent,
            ipAddress,
          }),
        )}
      />
    </AuthFrame>
  );
}
