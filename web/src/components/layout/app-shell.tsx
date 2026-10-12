import { NavLink, Outlet, useNavigate } from 'react-router';
import { Coins, Images, LayoutDashboard, LogOut, Sparkles, Wand2 } from 'lucide-react';
import { cn } from 'cn';
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
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/generate', label: 'Generate', icon: Wand2 },
  { to: '/gallery', label: 'Gallery', icon: Images },
];

/** Dashboard layout: sidebar + top bar. Pages render inside <Outlet />. */
export function AppShell() {
  const { data: user } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout.mutateAsync();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex min-h-screen bg-muted/40">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-background md:flex">
        <div className="flex h-14 items-center gap-2 border-b px-5 font-semibold">
          <Sparkles className="size-5 text-primary" />
          AI Media Studio
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-end gap-3 border-b bg-background px-4 sm:px-6">
          {/* Below md the sidebar is hidden: same links as icons in the top bar. */}
          <nav className="mr-auto flex items-center gap-1 md:hidden" aria-label="Main">
            {nav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end
                aria-label={label}
                className={({ isActive }) =>
                  cn('rounded-md p-2', isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')
                }
              >
                <Icon className="size-4" />
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium tabular-nums">
            <Coins className="size-4 text-amber-500" />
            {user?.credits ?? '–'} credits
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
                <Avatar className="size-8">
                  <AvatarFallback>{user?.email.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{user?.email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleLogout} disabled={logout.isPending}>
                <LogOut />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
