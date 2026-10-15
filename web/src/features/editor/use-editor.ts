import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type EditorConfig, type EditRequest, type Job, type Page, type Upload } from '@/lib/api';
import { meKey } from '@/features/auth/use-auth';
import { jobsKey } from '@/features/generation/use-generation';

export const editorConfigKey = ['editor', 'config'] as const;
export const uploadsKey = ['uploads'] as const;

export function useEditorConfig() {
  return useQuery({ queryKey: editorConfigKey, queryFn: () => api<EditorConfig>('/editor/config'), staleTime: Infinity });
}

/** The media library. Presigned URLs expire after 15 min: refresh well before that. */
export function useUploads() {
  return useQuery({
    queryKey: uploadsKey,
    queryFn: () => api<Page<Upload>>('/uploads?limit=50'),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}

/** MediaRecorder output often carries codec params ("video/webm;codecs=vp9"): the API wants the bare type. */
export const bareType = (t: string) => t.split(';')[0]!.trim().toLowerCase();

/**
 * Upload = 3 steps, and the file never goes through our API:
 *  1. POST /uploads -> a presigned POST (S3 itself enforces the size + type we declared)
 *  2. the browser POSTs the file straight to S3/MinIO (XHR, for a progress bar)
 *  3. POST /uploads/:id/complete -> the API checks it really is that kind of media
 */
export async function uploadFile(file: Blob, fileName: string, onProgress?: (fraction: number) => void): Promise<Upload> {
  const mimeType = bareType(file.type);
  const { upload, post } = await api<{ upload: Upload; post: { url: string; fields: Record<string, string> } }>('/uploads', {
    method: 'POST',
    body: JSON.stringify({ fileName, mimeType, bytes: file.size }),
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(post.fields)) form.append(k, v);
  form.append('file', file); // must be the LAST field for S3

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', post.url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, 'Upload was rejected by storage')));
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: network error'));
    xhr.send(form);
  });
  onProgress?.(1);
  const { upload: ready } = await api<{ upload: Upload }>(`/uploads/${upload.id}/complete`, { method: 'POST' });
  return ready;
}

export function useDeleteUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/uploads/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: uploadsKey }),
  });
}

/** Render the timeline. Fresh Idempotency-Key per click: a network retry can't charge twice. */
export function useRenderEdit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EditRequest) =>
      api<{ job: Job }>('/edits', { method: 'POST', body: JSON.stringify(input), headers: { 'Idempotency-Key': crypto.randomUUID() } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: meKey });
      void qc.invalidateQueries({ queryKey: ['credits'] });
      void qc.invalidateQueries({ queryKey: jobsKey });
    },
  });
}
