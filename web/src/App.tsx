import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Loader2 } from 'lucide-react';
import { GuestOnly, RequireAuth } from '@/features/auth/route-guards';

// Route-level code splitting: each page is its own JS chunk, downloaded only
// when that route is visited. The login page doesn't ship dashboard code.
const AppShell = lazy(() => import('@/components/layout/app-shell').then((m) => ({ default: m.AppShell })));
const DashboardPage = lazy(() => import('@/pages/dashboard-page').then((m) => ({ default: m.DashboardPage })));
const StudioPage = lazy(() => import('@/pages/studio-page').then((m) => ({ default: m.StudioPage })));
const GalleryPage = lazy(() => import('@/pages/gallery-page').then((m) => ({ default: m.GalleryPage })));
const LoginPage = lazy(() => import('@/pages/login-page').then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('@/pages/register-page').then((m) => ({ default: m.RegisterPage })));
const LandingPage = lazy(() => import('@/pages/landing-page').then((m) => ({ default: m.LandingPage })));
const NotFoundPage = lazy(() => import('@/pages/not-found-page').then((m) => ({ default: m.NotFoundPage })));

function PageFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="size-6 animate-spin text-primary" aria-label="Loading" />
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
          {/* One shell for all app pages (so the nav animates between them). Logged out,
              "/" shows the marketing page instead of redirecting to /login. */}
          <Route element={<RequireAuth landing={<LandingPage />} />}>
            <Route element={<AppShell />}>
              <Route index element={<DashboardPage />} />
              <Route path="/studio" element={<StudioPage />} />
              {/* Old link (bookmarks, README): keep it working. */}
              <Route path="/generate" element={<Navigate to="/studio" replace />} />
              <Route path="/gallery" element={<GalleryPage />} />
            </Route>
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
