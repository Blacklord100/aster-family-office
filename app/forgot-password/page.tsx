import { AuthFrame } from '@/components/auth/auth-frame';
import { PasswordRecovery } from '@/components/auth/password-recovery';
import { emailDeliveryEnabled } from '@/lib/server/delivery';
export const dynamic = 'force-dynamic';
export default function ForgotPassword() {
  return (
    <AuthFrame
      title="Recover your account"
      description="Request a one-time password reset link."
    >
      <PasswordRecovery enabled={emailDeliveryEnabled()} />
    </AuthFrame>
  );
}
