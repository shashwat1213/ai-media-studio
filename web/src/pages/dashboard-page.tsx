import { Link } from 'react-router';
import { ArrowRight, Coins, Images, Wand2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/features/auth/use-auth';
import { useCredits } from '@/features/credits/use-credits';
import { TransactionsTable } from '@/features/credits/transactions-table';
import { useAssets } from '@/features/generation/use-generation';

export function DashboardPage() {
  const { data: user } = useMe();
  const credits = useCredits(20);
  const recent = useAssets(6);
  const recentItems = recent.data?.pages[0]?.items ?? [];

  return (
    <motion.div
      className="mx-auto max-w-5xl space-y-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Signed in as {user?.email}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription>Credit balance</CardDescription>
            <Coins className="size-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            {credits.isLoading ? (
              <Skeleton className="h-9 w-24" />
            ) : (
              <p className="text-3xl font-semibold tabular-nums">{credits.data?.balance ?? 0}</p>
            )}
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-primary/10 to-transparent">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription>Create</CardDescription>
            <Wand2 className="size-4 text-primary" />
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Turn a text prompt into an image, from 2 credits.</p>
            <Button asChild>
              <Link to="/generate">
                Generate
                <ArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Recent creations</CardTitle>
            <CardDescription>Your latest images.</CardDescription>
          </div>
          {recentItems.length > 0 && (
            <Button asChild variant="ghost" size="sm">
              <Link to="/gallery">
                View all
                <ArrowRight />
              </Link>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {recent.isLoading ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="aspect-square w-full rounded-lg" />
              ))}
            </div>
          ) : recentItems.length === 0 ? (
            <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground">
              <Images className="size-5" />
              No images yet. <Link to="/generate" className="font-medium text-primary hover:underline">Create your first one</Link>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              {recentItems.map((a) => (
                <Link key={a.id} to="/gallery" className="overflow-hidden rounded-lg bg-muted" title={a.prompt}>
                  <img src={a.url} alt={a.prompt ?? 'Generated image'} loading="lazy" className="aspect-square w-full object-cover" />
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Credit history</CardTitle>
          <CardDescription>Every credit added or spent, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {credits.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn't load transactions: {credits.error.message}
            </p>
          ) : (
            <TransactionsTable transactions={credits.data?.transactions} isLoading={credits.isLoading} />
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
