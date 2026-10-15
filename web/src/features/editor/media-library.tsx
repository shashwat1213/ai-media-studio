import { useRef, useState } from 'react';
import { Circle, FileVideo, ImageIcon, Loader2, Plus, Square, Trash2, Upload as UploadIcon } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import type { EditorConfig, Upload } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes } from '@/features/generation/format';
import { useQueryClient } from '@tanstack/react-query';
import { bareType, uploadFile, uploadsKey, useDeleteUpload } from './use-editor';

interface Pending {
  id: string;
  name: string;
  progress: number;
}

/**
 * Media library: drop/pick screenshots or recordings, or record the screen right here.
 * Each file goes straight to storage (presigned POST) and is verified by the API.
 */
export function MediaLibrary({
  config,
  uploads,
  loading,
  onAdd,
}: {
  config: EditorConfig;
  uploads: Upload[];
  loading: boolean;
  onAdd: (u: Upload) => void;
}) {
  const qc = useQueryClient();
  const del = useDeleteUpload();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [drag, setDrag] = useState(false);

  async function send(file: Blob, name: string, addAfter = false) {
    const type = bareType(file.type);
    if (!config.uploadTypes.includes(type)) {
      toast.error(`${name}: unsupported file`, { description: 'Use PNG, JPEG, WebP, MP4, WebM or MOV.' });
      return;
    }
    const max = type.startsWith('image/') ? config.limits.imageBytes : config.limits.videoBytes;
    if (file.size > max) {
      toast.error(`${name} is too large`, { description: `Max ${formatBytes(max)}.` });
      return;
    }
    const id = Math.random().toString(36).slice(2);
    setPending((p) => [...p, { id, name, progress: 0 }]);
    try {
      const u = await uploadFile(file, name, (f) => setPending((p) => p.map((x) => (x.id === id ? { ...x, progress: f } : x))));
      await qc.invalidateQueries({ queryKey: uploadsKey });
      if (addAfter) onAdd(u);
    } catch (err) {
      toast.error(`${name}: upload failed`, { description: err instanceof Error ? err.message : undefined });
    } finally {
      setPending((p) => p.filter((x) => x.id !== id));
    }
  }

  const sendAll = (files: FileList | File[]) => Array.from(files).forEach((f) => void send(f, f.name));

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          sendAll(e.dataTransfer.files);
        }}
        className={cn(
          'rounded-xl border border-dashed p-3 text-center transition',
          drag ? 'border-primary bg-primary/10' : 'border-white/10 bg-white/[0.02]',
        )}
      >
        <p className="text-xs text-muted-foreground">Drop screenshots or screen recordings here</p>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <Button type="button" size="sm" variant="secondary" className="rounded-lg" onClick={() => input.current?.click()}>
            <UploadIcon />
            Upload
          </Button>
          <ScreenRecorder onDone={(blob, name) => void send(blob, name, true)} />
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={config.uploadTypes.join(',')}
          onChange={(e) => {
            if (e.target.files) sendAll(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {pending.map((p) => (
        <div key={p.id} className="rounded-lg bg-white/[0.03] px-2.5 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{p.name}</span>
            <span className="tabular-nums text-muted-foreground">{p.progress < 1 ? `${Math.round(p.progress * 100)}%` : 'Checking…'}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.max(4, p.progress * 100)}%` }} />
          </div>
        </div>
      ))}

      {loading ? (
        <div className="grid grid-cols-3 gap-1.5">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="aspect-video rounded-lg" />
          ))}
        </div>
      ) : uploads.length === 0 && pending.length === 0 ? (
        <p className="rounded-xl bg-white/[0.03] p-3 text-xs text-muted-foreground">No files yet. Upload a screenshot or record your screen to start.</p>
      ) : (
        <ul className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto pr-0.5" aria-label="Your files">
          {uploads.map((u) => (
            <li key={u.id} className="group relative aspect-video overflow-hidden rounded-lg bg-black ring-1 ring-white/[0.06]">
              {u.kind === 'image' ? (
                <img src={u.url ?? ''} alt={u.fileName} loading="lazy" className="size-full object-cover" />
              ) : (
                <video src={u.url ?? ''} muted preload="metadata" className="size-full object-cover" />
              )}
              <span className="absolute bottom-0.5 left-0.5 inline-flex items-center gap-0.5 rounded bg-black/70 px-1 text-[10px] text-white">
                {u.kind === 'image' ? <ImageIcon className="size-2.5" /> : <FileVideo className="size-2.5" />}
                {u.kind === 'video' && u.durationMs ? `${(u.durationMs / 1000).toFixed(0)}s` : ''}
              </span>
              <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/60 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:bg-black/30 [@media(hover:none)]:opacity-100">
                <button
                  type="button"
                  aria-label={`Add ${u.fileName} to the timeline`}
                  title="Add to timeline"
                  onClick={() => onAdd(u)}
                  className="grid size-7 place-items-center rounded-md bg-primary text-white"
                >
                  <Plus className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${u.fileName}`}
                  title="Delete file"
                  disabled={del.isPending}
                  onClick={() => del.mutate(u.id, { onError: (e) => toast.error(e.message) })}
                  className="grid size-7 place-items-center rounded-md bg-white/15 text-white hover:bg-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Pick the best recording format this browser supports (Chrome/Firefox: WebM, Safari: MP4). */
function recorderType() {
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

/**
 * Record a screen, window or tab with the browser's own picker (getDisplayMedia). Nothing is
 * installed and nothing leaves the machine until the user stops: then it uploads like any file.
 */
function ScreenRecorder({ onDone }: { onDone: (blob: Blob, name: string) => void }) {
  const [rec, setRec] = useState<{ recorder: MediaRecorder; started: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const supported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia) && recorderType() !== '';

  async function start() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    } catch {
      return; // user cancelled the picker
    }
    const type = recorderType();
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(timer);
      setRec(null);
      const blob = new Blob(chunks, { type: type.split(';')[0] });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      if (blob.size > 0) onDone(blob, `screen-${stamp}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
    };
    // The browser's own "Stop sharing" button ends the track: treat it as Stop.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => recorder.state !== 'inactive' && recorder.stop());
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    recorder.start(1000);
    setElapsed(0);
    setRec({ recorder, started });
  }

  if (!supported) {
    return (
      <Button type="button" size="sm" variant="secondary" className="rounded-lg" disabled title="Screen recording isn't supported in this browser">
        <Circle />
        Record
      </Button>
    );
  }
  return rec ? (
    <Button type="button" size="sm" variant="destructive" className="rounded-lg" onClick={() => rec.recorder.stop()}>
      <Square className="fill-current" />
      Stop · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
    </Button>
  ) : (
    <Button type="button" size="sm" variant="secondary" className="rounded-lg" onClick={() => void start()} title="Record your screen, a window or a tab">
      <Circle className="fill-destructive text-destructive" />
      Record
    </Button>
  );
}

export function UploadingHint() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Loader2 className="size-3 animate-spin" /> uploading
    </span>
  );
}
