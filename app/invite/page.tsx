import { AuthFrame } from '@/components/auth/auth-frame';
import { InviteForm } from '@/components/auth/invite-form';

export const dynamic = 'force-dynamic';

export default function InvitePage() {
  return (
    <AuthFrame
      title="Your workspace is waiting"
      description="Accept your invitation to Aster."
    >
      <InviteForm />
    </AuthFrame>
  );
}
