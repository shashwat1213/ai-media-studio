import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type User } from '@/lib/api';
import type { Credentials } from './schemas';

export const meKey = ['auth', 'me'] as const;

/**
 * "Who am I?" — the single source of truth for the logged-in user.
 * A 401 is a normal answer here (logged out), so we map it to null instead of an error.
 */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return (await api<{ user: User }>('/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: Credentials) => api<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify(c) }),
    onSuccess: ({ user }) => qc.setQueryData(meKey, user),
  });
}

/** Is the public one-click demo account configured on this server? */
export function useDemoEnabled() {
  return useQuery({
    queryKey: ['auth', 'demo'],
    queryFn: async () => (await api<{ enabled: boolean }>('/auth/demo')).enabled,
    staleTime: Infinity,
    retry: false,
  });
}

/** One click: the server logs you into the shared demo account (the password never reaches the browser). */
export function useDemoLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ user: User }>('/auth/demo', { method: 'POST', body: '{}' }),
    onSuccess: ({ user }) => qc.setQueryData(meKey, user),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: Credentials) => api<{ user: User }>('/auth/register', { method: 'POST', body: JSON.stringify(c) }),
    onSuccess: ({ user }) => qc.setQueryData(meKey, user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      // Drop ALL cached server data: the next user must never see the previous user's data.
      qc.clear();
      qc.setQueryData(meKey, null);
    },
  });
}
