import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Loader2 } from 'lucide-react';
import { useMe } from './use-auth';

function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="size-6 animate-spin text-primary" aria-label="Loading" />
    </div>
  );
}

/**
 * Only for logged-in users. Otherwise -> /login (remembering where they wanted to go),
 * except "/" which shows `landing` (the public marketing page) when given.
 */
export function RequireAuth({ landing }: { landing?: ReactNode } = {}) {
  const { data: user, isLoading } = useMe();
  const location = useLocation();
  if (isLoading) return <FullPageSpinner />;
  if (!user && landing && location.pathname === '/') return <>{landing}</>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** Only for logged-out users (login/register). Logged-in users go to the dashboard. */
export function GuestOnly() {
  const { data: user, isLoading } = useMe();
  if (isLoading) return <FullPageSpinner />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

