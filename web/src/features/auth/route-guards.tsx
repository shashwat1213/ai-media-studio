import { Navigate, Outlet, useLocation } from 'react-router';
import { Loader2 } from 'lucide-react';
import { useMe } from './use-auth';

function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading" />
    </div>
  );
}

/** Only for logged-in users. Otherwise -> /login (remembering where they wanted to go). */
export function RequireAuth() {
  const { data: user, isLoading } = useMe();
  const location = useLocation();
  if (isLoading) return <FullPageSpinner />;
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
