import { AuthFrame } from '@/components/auth/auth-frame';
import { PasswordRecovery } from '@/components/auth/password-recovery';
export const dynamic = 'force-dynamic';
export default function ResetPassword() {
  return (
    <AuthFrame
      title="Choose a new password"
      description="Your authenticator remains part of your account security."
    >
      <PasswordRecovery reset />
    </AuthFrame>
  );
}
