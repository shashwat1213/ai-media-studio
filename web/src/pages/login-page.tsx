import { useLocation, useNavigate } from 'react-router';
import { AuthForm } from '@/features/auth/auth-form';
import { useLogin } from '@/features/auth/use-auth';

export function LoginPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';

  return (
    <AuthForm
      mode="login"
      onSubmit={async (values) => {
        await login.mutateAsync(values);
        navigate(from, { replace: true });
      }}
    />
  );
}
