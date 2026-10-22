import { useNavigate } from 'react-router';
import { Loader2, PlayCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDemoEnabled, useDemoLogin } from './use-auth';

interface Props {
  className?: string;
  size?: 'sm' | 'default' | 'lg';
  label?: string;
  to?: string;
}

/**
 * "Try the live demo": one click into the shared demo account, no sign-up.
 * Renders nothing when the server has no demo account configured.
 */
export function DemoButton({ className, size = 'lg', label = 'Try the live demo (no sign-up)', to = '/director' }: Props) {
  const enabled = useDemoEnabled();
  const demo = useDemoLogin();
  const navigate = useNavigate();
  if (!enabled.data) return null;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button
        type="button"
        size={size}
        variant="outline"
        className={className}
        disabled={demo.isPending}
        onClick={async () => {
          try {
            await demo.mutateAsync();
            navigate(to, { replace: true });
          } catch {
            /* shown below */
          }
        }}
      >
        {demo.isPending ? <Loader2 className="animate-spin" /> : <PlayCircle />}
        {label}
      </Button>
      {demo.isError && (
        <p role="alert" className="text-xs text-destructive">
          {demo.error instanceof Error ? demo.error.message : 'Demo login failed'}
        </p>
      )}
    </div>
  );
}
