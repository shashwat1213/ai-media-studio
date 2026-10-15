import { useState } from 'react';
import { Check, FileVideo, ImageIcon, Loader2, Sparkles, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { api, type EditorConfig, type EditRequest, type EditTemplate, type Upload } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { fromRequest, type Editor } from './edit-state';

/**
 * "Quick start": pick a template, tick files (in order), give it a title -> the server builds a
 * full timeline (intro card, pacing, motion, transitions, captions, outro). Nothing is rendered or
 * charged; it lands in the editor where everything can still be changed by hand.
 */
export function TemplatePicker({
  open,
  onOpenChange,
  config,
  uploads,
  editor,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  config: EditorConfig;
  uploads: Upload[];
  editor: Editor;
}) {
  const [templateId, setTemplateId] = useState(config.templates[0]?.id ?? '');
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const template = config.templates.find((t) => t.id === templateId);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function build() {
    if (!template || picked.length === 0) return;
    if (editor.state.clips.length > 0 && !window.confirm('Replace the current timeline with this template?')) return;
    setBusy(true);
    try {
      const { draft } = await api<{ draft: EditRequest; totalS: number }>('/edits/build', {
        method: 'POST',
        body: JSON.stringify({ templateId: template.id, uploadIds: picked, title: title.trim() || undefined }),
      });
      editor.load(fromRequest(draft, title));
      onOpenChange(false);
      toast.success(`${template.name} ready`, { description: 'Press Play to preview. Click anything on the timeline to change it.' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not build the template');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" /> Start from a template
          </DialogTitle>
          <DialogDescription>Pick a style, tick your files in the order you want them, and we lay out the whole video. You can change everything afterwards.</DialogDescription>
        </DialogHeader>

        <section aria-label="Templates" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {config.templates.map((t) => (
            <TemplateCard key={t.id} t={t} active={t.id === templateId} onClick={() => setTemplateId(t.id)} />
          ))}
        </section>

        <section aria-label="Files" className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium">Your files</h3>
            <span className="text-[11px] text-muted-foreground">{picked.length ? `${picked.length} picked, numbers = order` : 'Tap to pick, in order'}</span>
          </div>
          {uploads.length === 0 ? (
            <p className="rounded-xl bg-white/[0.03] p-3 text-xs text-muted-foreground">Upload some photos, screenshots or recordings first (panel on the right).</p>
          ) : (
            <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
              {uploads.map((u) => {
                const n = picked.indexOf(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    aria-pressed={n >= 0}
                    aria-label={`${n >= 0 ? `#${n + 1} ` : ''}${u.fileName}`}
                    onClick={() => toggle(u.id)}
                    className={cn('relative aspect-square overflow-hidden rounded-lg bg-black ring-2 transition', n >= 0 ? 'ring-primary' : 'ring-transparent opacity-70 hover:opacity-100')}
                  >
                    {u.kind === 'image' ? (
                      <img src={u.url ?? ''} alt="" className="size-full object-cover" />
                    ) : (
                      <video src={u.url ?? ''} muted preload="metadata" className="size-full object-cover" />
                    )}
                    <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 p-0.5 text-white">
                      {u.kind === 'image' ? <ImageIcon className="size-3" /> : <FileVideo className="size-3" />}
                    </span>
                    {n >= 0 && <span className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-primary text-[11px] font-semibold text-white">{n + 1}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" className="rounded-lg" onClick={() => setPicked(uploads.map((u) => u.id))} disabled={!uploads.length}>
              <Check /> All
            </Button>
            <Button type="button" size="sm" variant="ghost" className="rounded-lg" onClick={() => setPicked([])} disabled={!picked.length}>
              Clear
            </Button>
          </div>
        </section>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input aria-label="Video title" placeholder={template?.intro ? 'Title on the intro card (optional)' : 'Title (optional)'} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} className="h-10 rounded-xl" />
          <Button className="btn-glow h-10 shrink-0 rounded-xl" disabled={!template || picked.length === 0 || busy} onClick={build}>
            {busy ? <Loader2 className="animate-spin" /> : <Wand2 />}
            Build timeline
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TemplateCard({ t, active, onClick }: { t: EditTemplate; active: boolean; onClick: () => void }) {
  const ratio = t.format === '9:16' ? '9 / 16' : t.format === '1:1' ? '1 / 1' : '16 / 9';
  const bg = t.intro ? `linear-gradient(135deg, ${t.intro.bg}, ${t.intro.bg2 ?? t.intro.bg})` : 'linear-gradient(135deg,#334155,#0f172a)';
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn('flex gap-3 rounded-xl p-2.5 text-left ring-1 transition', active ? 'bg-primary/10 ring-primary/50' : 'bg-white/[0.02] ring-white/[0.06] hover:ring-white/20')}
    >
      <span className="grid h-16 shrink-0 place-items-center rounded-md text-[10px] font-semibold text-white" style={{ aspectRatio: ratio, background: bg }}>
        {t.format}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{t.name}</span>
        <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">{t.description}</span>
      </span>
    </button>
  );
}
