import { Link } from 'react-router';
import { Aurora } from '@/components/fx/aurora';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-4 overflow-hidden p-6 text-center">
      <Aurora className="opacity-50" />
      <p className="text-gradient relative text-8xl font-semibold tracking-tighter">404</p>
      <p className="relative text-muted-foreground">This page doesn't exist.</p>
      <Button asChild className="btn-glow relative rounded-xl">
        <Link to="/">Go home</Link>
      </Button>
    </div>
  );
}
