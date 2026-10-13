import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CreditTransaction } from '@/lib/api';
import { reasonLabel } from './reason-label';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

interface Props {
  transactions?: CreditTransaction[];
  isLoading: boolean;
}

export function TransactionsTable({ transactions, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (!transactions?.length) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No transactions yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Balance</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {transactions.map((t) => (
          <TableRow key={t.id}>
            <TableCell className="text-xs text-muted-foreground">{dateFmt.format(new Date(t.createdAt))}</TableCell>
            <TableCell>
              <Badge variant="secondary" className="rounded-md bg-white/[0.06] font-normal">{reasonLabel[t.reason]}</Badge>
            </TableCell>
            <TableCell
              className={`text-right font-medium tabular-nums ${t.delta > 0 ? 'text-success' : 'text-foreground'}`}
            >
              {t.delta > 0 ? `+${t.delta}` : t.delta}
            </TableCell>
            <TableCell className="text-right tabular-nums">{t.balanceAfter}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
