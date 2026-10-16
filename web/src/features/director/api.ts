import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type EditRequest, type Voice } from '@/lib/api';
import { meKey } from '@/features/auth/use-auth';

export type LibraryKind = 'CHARACTER' | 'PLACE' | 'STYLE' | 'VOICE' | 'SOUND';
export interface LibraryItem {
  id: string;
  kind: LibraryKind;
  handle: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
  imageUploadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SceneShot {
  visual: string;
  camera: string;
  durationS: number;
  narration: string;
  /** Same line in Roman letters (Hinglish captions). */
  roman?: string;
  sound: string;
  onScreen: string;
  uses: string[];
  imageUploadId?: string;
  /** AI video: the shot's picture, animated. */
  videoUploadId?: string;
  voiceUploadId?: string;
  voiceS?: number;
  imagePrompt?: string;
}
/** hi = Hindi voice + Devanagari captions; hinglish = Hindi voice + Roman captions; en = English. */
export type SceneLanguage = 'hi' | 'hinglish' | 'en';

export interface Scene {
  id: string;
  prompt: string;
  language: SceneLanguage;
  format: '9:16' | '16:9' | '1:1';
  targetS: number;
  hd: boolean;
  /** 'ai' = every shot is a moving AI-video clip. */
  motion: 'still' | 'hero' | 'ai';
  /** 'auto' | 'none' | a built-in music track id. */
  music: string;
  voice: string;
  status: 'PLANNING' | 'PRODUCING' | 'READY' | 'FAILED';
  title: string | null;
  script: { title: string; mood: string; shots: SceneShot[]; soundUploadId?: string; music?: { id: string; bpm?: number }; ambience?: { id: string }; beatS?: number } | null;
  draft: (EditRequest & { totalS?: number }) | null;
  progress: string | null;
  error: string | null;
  createdAt: string;
  /** uploadId -> signed URL for this scene's pictures. */
  images: Record<string, string>;
}
export interface ScenesConfig {
  cost: number;
  limits: { shots: number; maxTotalS: number; prompt: number };
  /** Built-in music beds (synthesised on the server, free). */
  music: { id: string; name: string; bpm?: number }[];
  voices: Voice[];
  localAi: { llm: boolean; image: boolean; upscale: boolean; faceRef: boolean; video: boolean };
  hdCost: number;
  /** Extra credits for AI video (moving shots). */
  aiMotionExtra: number;
  heroMotionExtra: number;
}

export const libraryKey = ['library'] as const;
export const scenesKey = ['scenes'] as const;

export function useLibrary() {
  return useQuery({ queryKey: libraryKey, queryFn: () => api<{ items: LibraryItem[] }>('/library').then((r) => r.items) });
}

export function useSaveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (item: Partial<LibraryItem> & { id?: string }) =>
      item.id
        ? api<{ item: LibraryItem }>(`/library/${item.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ handle: item.handle, name: item.name, description: item.description, settings: item.settings, imageUploadId: item.imageUploadId }),
          })
        : api<{ item: LibraryItem }>('/library', { method: 'POST', body: JSON.stringify(item) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: libraryKey }),
  });
}

export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/library/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: libraryKey }),
  });
}

export function useScenesConfig() {
  return useQuery({ queryKey: ['scenes', 'config'], queryFn: () => api<ScenesConfig>('/scenes/config'), refetchInterval: 15_000 });
}

export function useScenes() {
  return useQuery({
    queryKey: scenesKey,
    queryFn: () => api<{ items: Scene[] }>('/scenes').then((r) => r.items),
    // Poll while anything is being made.
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === 'PLANNING' || s.status === 'PRODUCING') ? 2500 : false),
  });
}

export function useCreateScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { prompt: string; language: SceneLanguage | 'auto'; format: Scene['format']; targetS: number; voice?: string; hd: boolean; motion: 'still' | 'hero' | 'ai'; music: string }) =>
      api<{ scene: Scene }>('/scenes', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scenesKey });
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
}

export function useSceneAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'retry' | 'delete' }) =>
      action === 'retry' ? api(`/scenes/${id}/retry`, { method: 'POST' }) : api(`/scenes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scenesKey });
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
}
