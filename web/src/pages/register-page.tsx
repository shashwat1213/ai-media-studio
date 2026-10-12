import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AuthForm } from '@/features/auth/auth-form';
import { useRegister } from '@/features/auth/use-auth';

export function RegisterPage() {
  const register = useRegister();
  const navigate = useNavigate();

  return (
    <AuthForm
      mode="register"
      onSubmit={async (values) => {
        const { user } = await register.mutateAsync(values);
        toast.success(`Welcome! ${user.credits} free credits added.`);
        navigate('/', { replace: true });
      }}
    />
  );
}
