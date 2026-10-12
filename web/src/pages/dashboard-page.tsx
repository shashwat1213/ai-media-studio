import { Coins, Wand2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/features/auth/use-auth';
import { useCredits } from '@/features/credits/use-credits';
import { TransactionsTable } from '@/features/credits/transactions-table';

export function DashboardPage() {
  const { data: user } = useMe();
  const credits = useCredits(20);

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
        <Card className="border-dashed">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription>Generate</CardDescription>
            <Wand2 className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Text → image generation arrives in Phase 2.</p>
          </CardContent>
        </Card>
      </div>

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
