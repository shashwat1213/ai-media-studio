import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Loader2 } from 'lucide-react';
import { GuestOnly, RequireAuth } from '@/features/auth/route-guards';

// Route-level code splitting: each page is its own JS chunk, downloaded only
// when that route is visited. The login page doesn't ship dashboard code.
const AppShell = lazy(() => import('@/components/layout/app-shell').then((m) => ({ default: m.AppShell })));
const DashboardPage = lazy(() => import('@/pages/dashboard-page').then((m) => ({ default: m.DashboardPage })));
const LoginPage = lazy(() => import('@/pages/login-page').then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('@/pages/register-page').then((m) => ({ default: m.RegisterPage })));
const NotFoundPage = lazy(() => import('@/pages/not-found-page').then((m) => ({ default: m.NotFoundPage })));

function PageFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route element={<GuestOnly />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
          </Route>
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route index element={<DashboardPage />} />
            </Route>
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
