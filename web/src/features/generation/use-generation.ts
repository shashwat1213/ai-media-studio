import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type Asset, type Job, type ModelCatalog, type Page } from '@/lib/api';
import { meKey } from '@/features/auth/use-auth';

export const modelsKey = ['generate', 'models'] as const;
export const jobsKey = ['jobs'] as const;
export const jobKey = (id: string) => ['jobs', id] as const;
export const assetsKey = ['assets'] as const;

const isActive = (j: Pick<Job, 'status'>) => j.status === 'QUEUED' || j.status === 'PROCESSING';

/** The catalog almost never changes: cache it for the whole session. */
export function useModels() {
  return useQuery({
    queryKey: modelsKey,
    queryFn: () => api<ModelCatalog>('/generate/models'),
    staleTime: Infinity,
  });
}

/**
 * Recent jobs. While any job is still running we POLL every 1.5 s; as soon as everything
 * has finished, polling stops on its own (refetchInterval returns false). No websocket needed:
 * a status that changes a handful of times per job is exactly what short polling is good for.
 */
export function useRecentJobs(limit = 10) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...jobsKey, 'recent', limit],
    queryFn: async () => {
      const page = await api<Page<Job>>(`/jobs?limit=${limit}`);
      syncAfterFinish(qc, page.items);
      return page;
    },
    refetchInterval: (q) => (q.state.data?.items.some(isActive) ? 1500 : false),
  });
}

/** Single job, polled until it's DONE/FAILED. */
export function useJob(id: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: jobKey(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => {
      const { job } = await api<{ job: Job }>(`/jobs/${id}`);
      syncAfterFinish(qc, [job]);
      return job;
    },
    refetchInterval: (q) => (q.state.data && !isActive(q.state.data) ? false : 1500),
  });
}

/**
 * When a job we SAW running finishes, the server-side balance (refund) and the gallery changed.
 * Invalidate those caches once per transition, not on every poll, and not for jobs that were
 * already finished when the page loaded.
 */
const seenActive = new Set<string>();
function syncAfterFinish(qc: QueryClient, jobs: Job[]) {
  let changed = false;
  for (const j of jobs) {
    if (isActive(j)) {
      seenActive.add(j.id);
    } else if (seenActive.delete(j.id)) {
      changed = true;
    }
  }
  if (changed) {
    void qc.invalidateQueries({ queryKey: meKey });
    void qc.invalidateQueries({ queryKey: ['credits'] });
    void qc.invalidateQueries({ queryKey: assetsKey });
  }
}

export interface GenerateInput {
  prompt: string;
  model: string;
  aspectRatio: string;
}

export function useGenerate() {
  const qc = useQueryClient();
  return useMutation({
    // A fresh Idempotency-Key per click: if the network drops and the request is retried,
    // the server returns the same job instead of charging twice.
    mutationFn: (input: GenerateInput) =>
      api<{ job: Job }>('/generate', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }),
    onSuccess: () => {
      // Credits were reserved: refresh the balance now, and start polling the new job.
      void qc.invalidateQueries({ queryKey: meKey });
      void qc.invalidateQueries({ queryKey: ['credits'] });
      void qc.invalidateQueries({ queryKey: jobsKey });
    },
  });
}

/** Gallery with "Load more" (cursor pagination). */
export function useAssets(pageSize = 24) {
  return useInfiniteQuery({
    queryKey: [...assetsKey, pageSize],
    queryFn: ({ pageParam }) =>
      api<Page<Asset>>(`/assets?limit=${pageSize}${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Signed URLs expire after 15 min; refresh well before that if the tab stays open.
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}

export function useDeleteAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/assets/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: assetsKey });
      void qc.invalidateQueries({ queryKey: jobsKey });
    },
  });
}
