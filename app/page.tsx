import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, mfaRequired } from '@/lib/server/auth';
import { AsterApp } from '@/components/aster/app';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const current = await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
  if (!current) redirect('/login');
  if (
    mfaRequired() &&
    (!current.user.twoFactorEnabled || !current.session.mfaVerifiedAt)
  )
    redirect('/account');
  return <AsterApp />;
}
