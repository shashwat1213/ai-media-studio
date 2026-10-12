import { useQuery } from '@tanstack/react-query';
import { Sparkles, Activity, Database } from 'lucide-react';
import { api, type Health } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function App() {
  // Phase 0 smoke test: prove web -> api -> db wiring works.
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<Health>('/health'),
  });

  const apiUp = health.isSuccess;
  const dbUp = health.data?.db === 'up';

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            <CardTitle>AI Media Studio</CardTitle>
          </div>
          <CardDescription>Phase 0 scaffold — system status</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <StatusRow icon={<Activity className="size-4" />} label="API" ok={apiUp} loading={health.isLoading} />
          <StatusRow icon={<Database className="size-4" />} label="Database" ok={dbUp} loading={health.isLoading} />
          <Button variant="outline" className="w-full" onClick={() => health.refetch()} disabled={health.isFetching}>
            {health.isFetching ? 'Checking…' : 'Re-check'}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

function StatusRow({ icon, label, ok, loading }: { icon: React.ReactNode; label: string; ok: boolean; loading: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <span className="flex items-center gap-2 text-sm">
        {icon}
        {label}
      </span>
      {loading ? (
        <Badge variant="secondary">checking</Badge>
      ) : ok ? (
        <Badge>up</Badge>
      ) : (
        <Badge variant="destructive">down</Badge>
      )}
    </div>
  );
}
