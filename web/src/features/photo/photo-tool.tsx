import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Download, FlipHorizontal2, FlipVertical2, ImagePlus, Loader2, RotateCcw, RotateCw, Save, Upload as UploadIcon } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import type { EditorConfig, Upload } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { SettingsGroup } from '@/features/studio/studio-layout';
import { Segmented } from '@/features/editor/inspector';
import { bareType, uploadFile, uploadsKey } from '@/features/editor/use-editor';
import { formatBytes } from '@/features/generation/format';
import {
  ASPECTS, DEFAULT_EDIT, FILTERS, canvasBlob, editedName, isEdited, renderPhoto,
  type Adjust, type FilterId, type PhotoEdit, type Rotation, type TextPos, type TextStyle,
} from './photo-edit';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const PREVIEW_MAX = 1200;

/**
 * Photo tool state: which picture (from the user's uploads, incl. Scene Director shots), the edit,
 * and the loaded <img>. The chosen picture lives in the URL (?photo=<uploadId>) like Motion's ?src=.
 */
export function usePhotoTool(uploads: Upload[] | undefined, photoId: string | null, setPhotoId: (id: string) => void) {
  const images = useMemo(() => (uploads ?? []).filter((u) => u.kind === 'image' && u.status === 'READY' && u.url), [uploads]);
  const source = images.find((u) => u.id === photoId) ?? null;
  const [edit, setEdit] = useState<PhotoEdit>(DEFAULT_EDIT);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(null);

  // Load the picture with CORS so the canvas can be exported (MinIO/S3 send Allow-Origin).
  useEffect(() => {
    if (!source?.url) return;
    if (loadedId === source.id) return;
    let alive = true;
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => {
      if (!alive) return;
      setImg(el);
      setLoadError(false);
      setLoadedId(source.id);
    };
    el.onerror = () => alive && setLoadError(true);
    el.src = source.url;
    return () => {
      alive = false;
    };
  }, [source?.id, source?.url, loadedId]);

  const pick = (id: string) => {
    if (id === photoId) return;
    setEdit(DEFAULT_EDIT);
    setImg(null);
    setLoadedId(null);
    setPhotoId(id);
  };

  return {
    images,
    source,
    img: loadedId === source?.id ? img : null,
    loadError,
    edit,
    set: (patch: Partial<PhotoEdit>) => setEdit((e) => ({ ...e, ...patch })),
    adjust: (patch: Partial<Adjust>) => setEdit((e) => ({ ...e, adjust: { ...e.adjust, ...patch } })),
    text: (patch: Partial<PhotoEdit['text']>) => setEdit((e) => ({ ...e, text: { ...e.text, ...patch } })),
    rotate: (dir: 1 | -1) => setEdit((e) => ({ ...e, rotation: (((e.rotation + dir * 90) % 360) + 360) % 360 as Rotation, panX: 0, panY: 0 })),
    reset: () => setEdit(DEFAULT_EDIT),
    pick,
  };
}
export type PhotoTool = ReturnType<typeof usePhotoTool>;

/** Upload one or more pictures; resolves with the last READY upload. */
function useUploadPhotos(config: EditorConfig, onDone: (u: Upload) => void) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<{ name: string; progress: number } | null>(null);
  const send = async (files: FileList | File[]) => {
    let last: Upload | null = null;
    for (const file of Array.from(files)) {
      const type = bareType(file.type);
      if (!IMAGE_TYPES.includes(type) || !config.uploadTypes.includes(type)) {
        toast.error(`${file.name}: not a picture`, { description: 'Use PNG, JPEG or WebP.' });
        continue;
      }
      if (file.size > config.limits.imageBytes) {
        toast.error(`${file.name} is too large`, { description: `Max ${formatBytes(config.limits.imageBytes)}.` });
        continue;
      }
      setBusy({ name: file.name, progress: 0 });
      try {
        last = await uploadFile(file, file.name, (f) => setBusy({ name: file.name, progress: f }));
      } catch (err) {
        toast.error(`${file.name}: upload failed`, { description: err instanceof Error ? err.message : undefined });
      }
    }
    setBusy(null);
    if (last) {
      await qc.invalidateQueries({ queryKey: uploadsKey });
      onDone(last);
    }
  };
  return { busy, send };
}

/** The canvas: live preview of the edit, drop zone when empty. */
export function PhotoCanvas({ tool, config }: { tool: PhotoTool; config: EditorConfig }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const up = useUploadPhotos(config, (u) => tool.pick(u.id));

  useEffect(() => {
    if (tool.img && canvas.current) renderPhoto(canvas.current, tool.img, tool.edit, PREVIEW_MAX);
  }, [tool.img, tool.edit]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) void up.send(e.dataTransfer.files);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      className={cn(
        'glass relative grid min-h-[420px] place-items-center overflow-hidden rounded-2xl p-4 transition',
        drag && 'ring-2 ring-primary/60',
      )}
      style={{ backgroundImage: 'repeating-conic-gradient(rgba(255,255,255,0.03) 0 25%, transparent 0 50%)', backgroundSize: '24px 24px' }}
    >
      <input ref={input} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden onChange={(e) => e.target.files && void up.send(e.target.files)} />
      {up.busy ? (
        <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-6 animate-spin text-primary" />
          Uploading {up.busy.name}… {Math.round(up.busy.progress * 100)}%
        </div>
      ) : !tool.source ? (
        <div className="max-w-sm text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
            <ImagePlus className="size-5" />
          </div>
          <p className="mt-4 font-medium">Upload a photo to edit</p>
          <p className="mt-1 text-sm text-muted-foreground">Drop a picture here, or pick one from your library on the right. PNG, JPEG or WebP.</p>
          <Button className="mt-4" onClick={() => input.current?.click()}>
            <UploadIcon /> Upload photo
          </Button>
        </div>
      ) : tool.loadError ? (
        <p role="alert" className="text-sm text-destructive">Couldn't load this picture. Refresh and try again.</p>
      ) : !tool.img ? (
        <Skeleton className="h-[380px] w-[280px] rounded-xl" />
      ) : (
        <canvas ref={canvas} aria-label={`Preview of ${tool.source.fileName}`} className="max-h-[70vh] max-w-full rounded-lg shadow-2xl" />
      )}
    </div>
  );
}

function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="block space-y-1">
      <span className="flex justify-between text-[11px] text-muted-foreground">
        {label}
        <button type="button" onClick={() => onChange(0)} className={cn('tabular-nums', value !== 0 && 'text-foreground hover:text-primary')} title="Reset">
          {value > 0 && min < 0 ? `+${value}` : value}
        </button>
      </span>
      <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--primary)]" />
    </label>
  );
}

/** The settings panel: library + upload, crop/rotate, filters, adjust, text, save. */
export function PhotoSettings({ tool, config, uploadsLoading }: { tool: PhotoTool; config: EditorConfig; uploadsLoading: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const up = useUploadPhotos(config, (u) => tool.pick(u.id));
  const [saving, setSaving] = useState(false);
  const e = tool.edit;
  const ready = !!tool.img && !!tool.source;

  const fullSize = async () => {
    const c = document.createElement('canvas');
    renderPhoto(c, tool.img!, e);
    return canvasBlob(c, 'image/jpeg');
  };

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    try {
      const blob = await fullSize();
      if (blob.size > config.limits.imageBytes) throw new Error(`The edited picture is larger than ${formatBytes(config.limits.imageBytes)}.`);
      const u = await uploadFile(blob, editedName(tool.source!.fileName));
      await qc.invalidateQueries({ queryKey: uploadsKey });
      toast.success('Saved to your library', { description: 'Use it in the Editor, Motion or the Scene Director.' });
      tool.pick(u.id);
    } catch (err) {
      toast.error('Could not save', { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const download = async () => {
    if (!ready) return;
    const blob = await fullSize();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = editedName(tool.source!.fileName);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  return (
    <div>
      <SettingsGroup
        title="Your photos"
        aside={
          <Button size="xs" variant="ghost" onClick={() => input.current?.click()} disabled={!!up.busy}>
            {up.busy ? <Loader2 className="animate-spin" /> : <UploadIcon />} Upload
          </Button>
        }
      >
        <input ref={input} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden onChange={(ev) => ev.target.files && void up.send(ev.target.files)} />
        {uploadsLoading ? (
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-square rounded-lg" />)}
          </div>
        ) : tool.images.length === 0 ? (
          <p className="rounded-xl bg-white/[0.03] p-3 text-xs text-muted-foreground">No photos yet. Upload one to start.</p>
        ) : (
          <div role="radiogroup" aria-label="Photo" className="grid max-h-40 grid-cols-4 gap-1.5 overflow-y-auto pr-0.5">
            {tool.images.map((u) => {
              const active = tool.source?.id === u.id;
              return (
                <button
                  key={u.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={u.fileName}
                  title={u.fileName}
                  onClick={() => tool.pick(u.id)}
                  className={cn('relative aspect-square overflow-hidden rounded-lg ring-2 transition', active ? 'ring-primary' : 'ring-transparent opacity-70 hover:opacity-100')}
                >
                  <img src={u.url!} alt="" loading="lazy" className="size-full object-cover" />
                  {active && (
                    <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-primary">
                      <Check className="size-3 text-white" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </SettingsGroup>

      <fieldset disabled={!ready} className="mt-5 min-w-0 border-t border-white/[0.06] pt-5">
        <SettingsGroup title="Crop & rotate">
          <div className="grid grid-cols-3 gap-1">
            {ASPECTS.map((a) => (
              <button
                key={a.id}
                type="button"
                aria-pressed={e.aspect === a.id}
                onClick={() => tool.set({ aspect: a.id, zoom: 1, panX: 0, panY: 0 })}
                className={cn('rounded-md px-2 py-1 text-xs transition', e.aspect === a.id ? 'bg-primary/20 text-foreground ring-1 ring-primary/40' : 'bg-white/[0.03] text-muted-foreground hover:text-foreground')}
              >
                {a.label}
              </button>
            ))}
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Zoom {e.zoom.toFixed(1)}×</span>
            <input type="range" min={1} max={3} step={0.05} value={e.zoom} onChange={(ev) => tool.set({ zoom: Number(ev.target.value) })} className="w-full accent-[var(--primary)]" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">Move ←→</span>
              <input type="range" min={-1} max={1} step={0.02} value={e.panX} onChange={(ev) => tool.set({ panX: Number(ev.target.value) })} className="w-full accent-[var(--primary)]" />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">Move ↑↓</span>
              <input type="range" min={-1} max={1} step={0.02} value={e.panY} onChange={(ev) => tool.set({ panY: Number(ev.target.value) })} className="w-full accent-[var(--primary)]" />
            </label>
          </div>
          <div className="flex gap-1">
            <Button size="icon-sm" variant="ghost" title="Rotate left" aria-label="Rotate left" onClick={() => tool.rotate(-1)}><RotateCcw /></Button>
            <Button size="icon-sm" variant="ghost" title="Rotate right" aria-label="Rotate right" onClick={() => tool.rotate(1)}><RotateCw /></Button>
            <Button size="icon-sm" variant={e.flipH ? 'secondary' : 'ghost'} title="Flip horizontal" aria-label="Flip horizontal" aria-pressed={e.flipH} onClick={() => tool.set({ flipH: !e.flipH })}><FlipHorizontal2 /></Button>
            <Button size="icon-sm" variant={e.flipV ? 'secondary' : 'ghost'} title="Flip vertical" aria-label="Flip vertical" aria-pressed={e.flipV} onClick={() => tool.set({ flipV: !e.flipV })}><FlipVertical2 /></Button>
          </div>
        </SettingsGroup>

        <SettingsGroup title="Filter">
          <div className="grid grid-cols-4 gap-1.5">
            {(Object.keys(FILTERS) as FilterId[]).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={e.filter === f}
                onClick={() => tool.set({ filter: f })}
                className={cn('overflow-hidden rounded-lg text-[10px] ring-2 transition', e.filter === f ? 'ring-primary text-foreground' : 'ring-transparent text-muted-foreground hover:text-foreground')}
              >
                {tool.source?.url && <img src={tool.source.url} alt="" loading="lazy" className="aspect-square w-full object-cover" style={{ filter: FILTERS[f].css || undefined }} />}
                <span className="block py-0.5">{FILTERS[f].label}</span>
              </button>
            ))}
          </div>
        </SettingsGroup>

        <SettingsGroup title="Adjust">
          <Slider label="Brightness" value={e.adjust.brightness} min={-100} max={100} onChange={(v) => tool.adjust({ brightness: v })} />
          <Slider label="Contrast" value={e.adjust.contrast} min={-100} max={100} onChange={(v) => tool.adjust({ contrast: v })} />
          <Slider label="Saturation" value={e.adjust.saturation} min={-100} max={100} onChange={(v) => tool.adjust({ saturation: v })} />
          <Slider label="Warmth" value={e.adjust.warmth} min={-100} max={100} onChange={(v) => tool.adjust({ warmth: v })} />
          <Slider label="Vignette" value={e.adjust.vignette} min={0} max={100} onChange={(v) => tool.adjust({ vignette: v })} />
          <Slider label="Blur" value={e.adjust.blur} min={0} max={100} onChange={(v) => tool.adjust({ blur: v })} />
        </SettingsGroup>

        <SettingsGroup title="Text">
          <Textarea value={e.text.text} maxLength={140} rows={2} placeholder="Write something on the photo…" onChange={(ev) => tool.text({ text: ev.target.value })} className="text-sm" />
          <Segmented<TextPos> label="Position" value={e.text.pos} options={[['top', 'Top'], ['center', 'Middle'], ['bottom', 'Bottom']]} onChange={(pos) => tool.text({ pos })} />
          <Segmented<TextStyle> label="Style" value={e.text.style} options={[['box', 'Box'], ['outline', 'Outline'], ['plain', 'Shadow']]} onChange={(style) => tool.text({ style })} />
          <label className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">Size</span>
            <input type="range" min={0.03} max={0.15} step={0.005} value={e.text.size} onChange={(ev) => tool.text({ size: Number(ev.target.value) })} className="w-full accent-[var(--primary)]" />
          </label>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Text color">
            {['#ffffff', '#000000', '#facc15', '#f43f5e', '#22d3ee', '#a3e635'].map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={e.text.color === c}
                aria-label={c}
                onClick={() => tool.text({ color: c })}
                className={cn('size-6 rounded-full ring-2 ring-offset-2 ring-offset-background transition', e.text.color === c ? 'ring-primary' : 'ring-white/10')}
                style={{ background: c }}
              />
            ))}
          </div>
        </SettingsGroup>

        <div className="mt-5 space-y-2 border-t border-white/[0.06] pt-5">
          <Button className="w-full" onClick={save} disabled={!ready || saving || !isEdited(e)}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />} Save as new photo
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={download} disabled={!ready}>
              <Download /> Download
            </Button>
            <Button variant="ghost" onClick={tool.reset} disabled={!ready || !isEdited(e)}>
              <RotateCcw /> Reset
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Free. Edits run in your browser; the original is kept.</p>
        </div>
      </fieldset>
    </div>
  );
}
