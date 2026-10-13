import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { Coins, Images, LayoutDashboard, LogOut, Plus, Wand2 } from 'lucide-react';
import { cn } from 'cn';
import { Logo } from '@/components/brand/logo';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLogout, useMe } from '@/features/auth/use-auth';

const nav = [
  { to: '/', label: 'Home', icon: LayoutDashboard },
  { to: '/studio', label: 'Studio', icon: Wand2 },
  { to: '/gallery', label: 'Gallery', icon: Images },
];

/**
 * Studio layout: a floating glass top bar (desktop tabs with a sliding indicator), a bottom tab
 * bar on phones, and pages that fade between routes.
 */
export function AppShell() {
  const { data: user } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();

  async function handleLogout() {
    await logout.mutateAsync();
    navigate('/login', { replace: true });
  }

  const initials = user?.email.split('@')[0]?.slice(0, 2).toUpperCase();

  return (
    <div className="relative min-h-screen bg-background">
      {/* faint violet haze at the top of every page */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-[radial-gradient(60%_100%_at_50%_0%,oklch(0.55_0.25_293/18%),transparent)]" />

      <header className="sticky top-0 z-40 px-3 pt-3 sm:px-5">
        <div className="glass mx-auto flex h-14 max-w-7xl items-center gap-3 rounded-2xl px-3 sm:px-4">
          <NavLink to="/" aria-label="Home" className="shrink-0">
            <Logo className="hidden text-sm sm:inline-flex" />
            <Logo compact className="sm:hidden" />
          </NavLink>

          <nav aria-label="Main" className="mx-auto hidden items-center gap-1 rounded-xl bg-white/[0.03] p-1 md:flex">
            {nav.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} end className="relative rounded-lg px-3.5 py-1.5 text-sm font-medium">
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span
                        layoutId="nav-pill"
                        className="absolute inset-0 rounded-lg bg-white/[0.08] ring-1 ring-white/10"
                        transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                      />
                    )}
                    <span className={cn('relative flex items-center gap-2 transition-colors', isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                      <Icon className="size-4" />
                      {label}
                    </span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <Button asChild size="sm" className="btn-glow hidden rounded-xl sm:inline-flex">
              <NavLink to="/studio">
                <Plus />
                Create
              </NavLink>
            </Button>
            <NavLink
              to="/"
              className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm font-medium tabular-nums transition-colors hover:bg-white/[0.06]"
              aria-label={`${user?.credits ?? 0} credits`}
            >
              <Coins className="size-4 text-warning" />
              <motion.span key={user?.credits} initial={{ y: -6, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
                {user?.credits ?? '–'}
              </motion.span>
            </NavLink>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
                  <Avatar className="size-8 ring-1 ring-white/15">
                    <AvatarFallback className="bg-gradient-to-br from-primary/80 to-violet-2/80 text-xs font-semibold text-white">{initials}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{user?.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={handleLogout} disabled={logout.isPending}>
                  <LogOut />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="relative px-4 pb-28 pt-6 sm:px-6 md:pb-12">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Phone tab bar */}
      <nav aria-label="Main" className="glass fixed inset-x-3 bottom-3 z-40 flex h-16 items-center justify-around rounded-2xl md:hidden">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end
            className={({ isActive }) =>
              cn('flex flex-col items-center gap-1 rounded-xl px-5 py-1.5 text-[11px] font-medium', isActive ? 'text-foreground' : 'text-muted-foreground')
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={cn('size-5', isActive && 'text-primary drop-shadow-[0_0_8px_var(--glow)]')} />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
