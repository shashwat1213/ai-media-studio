import { Link } from 'react-router';
import { motion } from 'framer-motion';
import { ArrowRight, ArrowUpRight, Coins, Images, Sparkles, TrendingDown, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/features/auth/use-auth';
import { useCredits } from '@/features/credits/use-credits';
import { TransactionsTable } from '@/features/credits/transactions-table';
import { useAssets } from '@/features/generation/use-generation';
import { useSpotlight } from '@/lib/use-spotlight';

const fade = (i: number) => ({ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { delay: i * 0.05 } });

export function DashboardPage() {
  const { data: user } = useMe();
  const credits = useCredits(20);
  const recent = useAssets(8);
  const recentItems = recent.data?.pages[0]?.items ?? [];
  const spent = credits.data?.transactions.filter((t) => t.delta < 0).reduce((s, t) => s - t.delta, 0) ?? 0;
  const name = user?.email.split('@')[0];
  const spot = useSpotlight<HTMLDivElement>();

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <motion.div {...fade(0)}>
        <p className="text-sm text-muted-foreground">Welcome back{name ? `, ${name}` : ''}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">Your studio</h1>
      </motion.div>

      <div className="grid gap-4 md:grid-cols-3">
        {/* Big create card */}
        <motion.div {...fade(1)} className="md:col-span-2">
          <div onPointerMove={spot} className="spotlight group relative h-full overflow-hidden rounded-2xl border bg-card p-6 sm:p-8">
            <div aria-hidden className="absolute -right-24 -top-24 size-72 rounded-full bg-primary/25 blur-3xl transition-transform duration-700 group-hover:scale-125" />
            <div aria-hidden className="absolute -bottom-28 right-24 size-56 rounded-full bg-violet-2/20 blur-3xl" />
            <div className="relative flex h-full flex-col justify-between gap-8">
              <div>
                <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary ring-1 ring-primary/25">
                  <Sparkles className="size-3.5" />
                  Text to image
                </div>
                <h2 className="mt-4 max-w-md text-2xl font-semibold tracking-tight sm:text-3xl">Turn your next idea into an image.</h2>
                <p className="mt-2 max-w-md text-sm text-muted-foreground">Pick a model, choose a shape, describe the scene. From 2 credits.</p>
              </div>
              <Button asChild size="lg" className="btn-glow w-fit rounded-xl">
                <Link to="/generate">
                  <Wand2 />
                  Start creating
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
        </motion.div>

        {/* Stats */}
        <div className="grid gap-4">
          <motion.div {...fade(2)} className="rounded-2xl border bg-card p-5">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              Credits
              <Coins className="size-4 text-warning" />
            </div>
            {credits.isLoading ? (
              <Skeleton className="mt-3 h-9 w-24" />
            ) : (
              <p className="mt-2 text-4xl font-semibold tabular-nums tracking-tight">{credits.data?.balance ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">≈ {Math.floor((credits.data?.balance ?? 0) / 2)} fast images</p>
          </motion.div>
          <motion.div {...fade(3)} className="grid grid-cols-2 gap-4">
            <div className="rounded-2xl border bg-card p-5">
              <Images className="size-4 text-muted-foreground" />
              <p className="mt-3 text-2xl font-semibold tabular-nums">
                {recentItems.length}
                {recent.hasNextPage ? '+' : ''}
              </p>
              <p className="text-xs text-muted-foreground">images</p>
            </div>
            <div className="rounded-2xl border bg-card p-5">
              <TrendingDown className="size-4 text-muted-foreground" />
              <p className="mt-3 text-2xl font-semibold tabular-nums">{spent}</p>
              <p className="text-xs text-muted-foreground">credits used</p>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Recent */}
      <motion.section {...fade(4)}>
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Recent creations</h2>
          {recentItems.length > 0 && (
            <Link to="/gallery" className="inline-flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground">
              View all
              <ArrowUpRight className="size-4" />
            </Link>
          )}
        </div>
        {recent.isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="aspect-square w-full rounded-2xl" />
            ))}
          </div>
        ) : recentItems.length === 0 ? (
          <Link
            to="/generate"
            className="flex items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 py-12 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
          >
            <Sparkles className="size-4 text-primary" />
            No images yet. Create your first one.
          </Link>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {recentItems.slice(0, 8).map((a, i) => (
              <motion.div key={a.id} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.1 + i * 0.04 }}>
                <Link to="/gallery" className="group block overflow-hidden rounded-2xl bg-card ring-1 ring-white/[0.07]" title={a.prompt}>
                  <img src={a.url} alt={a.prompt ?? 'Generated image'} loading="lazy" className="aspect-square w-full object-cover transition duration-500 group-hover:scale-105" />
                </Link>
              </motion.div>
            ))}
          </div>
        )}
      </motion.section>

      {/* Ledger */}
      <motion.section {...fade(5)} className="rounded-2xl border bg-card">
        <div className="border-b border-white/[0.06] px-5 py-4">
          <h2 className="font-semibold tracking-tight">Credit history</h2>
          <p className="text-xs text-muted-foreground">Every credit added or spent, newest first.</p>
        </div>
        <div className="px-2 pb-2 sm:px-3">
          {credits.isError ? (
            <p role="alert" className="p-4 text-sm text-destructive">
              Couldn't load transactions: {credits.error.message}
            </p>
          ) : (
            <TransactionsTable transactions={credits.data?.transactions} isLoading={credits.isLoading} />
          )}
        </div>
      </motion.section>
    </div>
  );
}
