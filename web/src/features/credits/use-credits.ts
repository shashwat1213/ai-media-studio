import { useQuery } from '@tanstack/react-query';
import { api, type CreditSummary } from '@/lib/api';

export const creditsKey = (limit: number) => ['credits', limit] as const;

export function useCredits(limit = 20) {
  return useQuery({
    queryKey: creditsKey(limit),
    queryFn: () => api<CreditSummary>(`/credits?limit=${limit}`),
  });
}
