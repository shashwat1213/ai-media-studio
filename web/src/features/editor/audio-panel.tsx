import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Captions, Coins, FileAudio, Loader2, Mic, Pause, Play, Plus, Trash2, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { api, type AudioConfig, type Upload } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { meKey } from '@/features/auth/use-auth';
import { uploadsKey } from './use-editor';
import { formatTime, round2, type Editor } from './edit-state';

export const audioConfigKey = ['audio', 'config'] as const;
export function useAudioConfig() {
  return useQuery({ queryKey: audioConfigKey, queryFn: () => api<AudioConfig>('/audio/config'), staleTime: Infinity });
}

/** Poll an upload while its transcription runs; refresh the library when it finishes. */
function useTranscriptPoll(ids: string[]) {
  const qc = useQueryClient();
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    const t = setInterval(async () => {
      const done = await Promise.all(key.split(',').map((id) => api<{ upload: Upload }>(`/uploads/${id}`).then((r) => r.upload.transcriptStatus !== 'PENDING')));
      if (done.some(Boolean)) {
        void qc.invalidateQueries({ queryKey: uploadsKey });
        void qc.invalidateQueries({ queryKey: meKey });
      }
    }, 2000);
    return () => clearInterval(t);
  }, [key, qc]);
}

export function useTranscribe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, language }: { id: string; language?: string }) =>
      api<{ status: string; cost: number }>(`/uploads/${id}/transcribe`, { method: 'POST', body: JSON.stringify(language ? { language } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: uploadsKey });
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
}

/**
 * The Audio panel: write a script -> voice-over; your sound files (voice-overs, music, videos with
 * speech) with "Add to audio track", "Transcribe" and "Auto captions".
 */
export function AudioPanel({ editor, uploads, time, balance }: { editor: Editor; uploads: Upload[]; time: number; balance: number }) {
  const cfg = useAudioConfig();
  const qc = useQueryClient();
  const transcribe = useTranscribe();
  const [script, setScript] = useState('');
  const [voice, setVoice] = useState('luna');
  const [busy, setBusy] = useState(false);
  const [showScript, setShowScript] = useState(false);

  const sounds = uploads.filter((u) => u.kind === 'audio' || (u.kind === 'video' && u.hasAudio));
  useTranscriptPoll(sounds.filter((u) => u.transcriptStatus === 'PENDING').map((u) => u.id));

  const ttsCost = cfg.data ? Math.max(1, Math.ceil(script.trim().length / cfg.data.tts.charsPerCredit)) : 1;

  async function makeVoice() {
    setBusy(true);
    try {
      const { upload } = await api<{ upload: Upload }>('/voiceovers', { method: 'POST', body: JSON.stringify({ script, voice }) });
      await qc.invalidateQueries({ queryKey: uploadsKey });
      void qc.invalidateQueries({ queryKey: meKey });
      // Straight onto the timeline at the playhead, and transcribe it (free) for captions.
      editor.addAudio(upload, time);
      transcribe.mutate({ id: upload.id });
      toast.success('Voice-over added', { description: 'On the audio track at the playhead. Captions are being prepared.' });
      setScript('');
      setShowScript(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Voice-over failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {showScript ? (
        <div className="space-y-2 rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/[0.06]">
          <Textarea
            aria-label="Voice-over script"
            placeholder="Write what the narrator should say…"
            rows={4}
            maxLength={cfg.data?.tts.maxChars ?? 3000}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            className="resize-none rounded-lg text-sm"
          />
          <div className="flex items-center gap-2">
            <select aria-label="Voice" value={voice} onChange={(e) => setVoice(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-xs">
              {(cfg.data?.voices ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.gender === 'female' ? '♀' : '♂'} · {v.style}
                </option>
              ))}
            </select>
            <VoiceSample voice={voice} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {script.length}/{cfg.data?.tts.maxChars ?? 3000} · English voices
            </span>
            <Button size="sm" className="rounded-lg" disabled={!script.trim() || busy || balance < ttsCost} onClick={makeVoice}>
              {busy ? <Loader2 className="animate-spin" /> : <Mic />}
              Generate
              <span className="inline-flex items-center gap-0.5 text-warning">
                <Coins className="size-3" />
                {ttsCost}
              </span>
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="secondary" className="w-full rounded-lg" onClick={() => setShowScript(true)}>
          <Mic />
          Voice-over from a script
        </Button>
      )}

      {sounds.length === 0 ? (
        <p className="rounded-xl bg-white/[0.03] p-3 text-xs text-muted-foreground">Upload music or a video with speech, or generate a voice-over.</p>
      ) : (
        <ul className="space-y-1.5" aria-label="Sound files">
          {sounds.map((u) => (
            <SoundRow key={u.id} u={u} editor={editor} time={time} onTranscribe={(id) => transcribe.mutate({ id }, { onError: (e) => toast.error(e.message) })} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SoundRow({ u, editor, time, onTranscribe }: { u: Upload; editor: Editor; time: number; onTranscribe: (id: string) => void }) {
  const onTrack = editor.state.audio.some((a) => a.uploadId === u.id) || editor.state.clips.some((c) => c.kind === 'media' && c.uploadId === u.id);
  const captioned = editor.state.autoCaptions?.uploadId === u.id;
  const t = u.transcriptStatus;
  return (
    <li className="rounded-lg bg-white/[0.03] p-2 text-xs ring-1 ring-white/[0.05]">
      <div className="flex items-center gap-2">
        {u.kind === 'audio' ? <FileAudio className="size-4 shrink-0 text-primary" /> : <AudioLines className="size-4 shrink-0 text-sky-400" />}
        <span className="min-w-0 flex-1 truncate" title={u.script ?? u.fileName}>
          {u.fileName}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime((u.durationMs ?? 0) / 1000)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {u.kind === 'audio' && (
          <>
            <MiniAction onClick={() => editor.addAudio(u, time)} title="Add at the playhead">
              <Plus /> Voice track
            </MiniAction>
            <MiniAction onClick={() => editor.addAudio(u, 0, true)} title="Background music: starts at 0, quieter, dips under the voice">
              <Volume2 /> As music
            </MiniAction>
          </>
        )}
        {t === 'DONE' ? (
          <MiniAction
            active={captioned}
            disabled={!onTrack}
            title={onTrack ? 'Word-by-word captions from this audio' : 'Put it on the timeline first'}
            onClick={() => editor.setAutoCaptions(captioned ? null : { uploadId: u.id, y: 0.72, size: 'l', color: '#ffffff', highlight: '#facc15', style: 'outline', maxWords: 3 })}
          >
            <Captions /> {captioned ? 'Captions on' : 'Auto captions'}
          </MiniAction>
        ) : t === 'PENDING' ? (
          <span className="inline-flex items-center gap-1 px-1.5 py-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> transcribing…
          </span>
        ) : (
          <MiniAction onClick={() => onTranscribe(u.id)} title={u.source === 'TTS' ? 'Free for voice-overs' : '1 credit per minute'}>
            <Captions /> {t === 'FAILED' ? 'Retry transcript' : 'Transcribe'}
          </MiniAction>
        )}
      </div>
      {t === 'FAILED' && u.transcriptError && <p className="mt-1 text-[11px] text-destructive">{u.transcriptError}</p>}
      {t === 'DONE' && u.transcript && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">Transcript · {u.transcript.language}</summary>
          <p className="mt-1 max-h-28 overflow-y-auto text-[11px] leading-relaxed text-foreground/80">{u.transcript.text || '(no speech found)'}</p>
        </details>
      )}
    </li>
  );
}

function MiniAction({ children, onClick, title, active, disabled }: { children: React.ReactNode; onClick: () => void; title?: string; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] ring-1 transition disabled:opacity-40 [&_svg]:size-3',
        active ? 'bg-primary/20 text-foreground ring-primary/40' : 'text-muted-foreground ring-white/10 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Plays a cached short sample of a voice (generated once per voice, free tier). Optional nicety: no-op on error. */
function VoiceSample({ voice }: { voice: string }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => ref.current?.pause(), []);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-8 shrink-0 rounded-lg px-2"
      aria-label={playing ? 'Stop sample' : 'Play a sample of this voice'}
      onClick={() => {
        if (playing) {
          ref.current?.pause();
          setPlaying(false);
          return;
        }
        const a = new Audio(`/api/audio/sample/${voice}`);
        ref.current = a;
        a.onended = () => setPlaying(false);
        a.onerror = () => setPlaying(false);
        void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
      }}
    >
      {playing ? <Pause /> : <Play />}
    </Button>
  );
}

/** Inspector for one audio track. */
export function AudioTrackInspector({ editor, trackKey, uploads }: { editor: Editor; trackKey: string; uploads: Map<string, Upload> }) {
  const a = editor.state.audio.find((x) => x.key === trackKey);
  if (!a) return null;
  const u = uploads.get(a.uploadId);
  const srcS = (u?.durationMs ?? 0) / 1000;
  return (
    <section aria-label="Audio track" className="space-y-3 rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/[0.06]">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-medium">Audio · {u?.fileName}</h3>
        <Button size="sm" variant="ghost" className="h-7 rounded-lg text-muted-foreground hover:text-destructive" onClick={() => editor.removeAudio(a.key)}>
          <Trash2 /> Remove
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Num label="Starts at (s)" value={a.atS} min={0} max={Math.max(0, editor.total - 0.1)} onChange={(v) => editor.updateAudio(a.key, { atS: v })} />
        <Num label="Skip first (s)" value={a.trimStartS} min={0} max={Math.max(0, srcS - 0.1)} onChange={(v) => editor.updateAudio(a.key, { trimStartS: v })} />
      </div>
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">Volume · {Math.round(a.volume * 100)}%</span>
        <input type="range" min={0} max={2} step={0.05} value={a.volume} onChange={(e) => editor.updateAudio(a.key, { volume: Number(e.target.value) })} className="w-full accent-[var(--primary)]" />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={a.duck} onChange={(e) => editor.updateAudio(a.key, { duck: e.target.checked })} />
        Background music: dip under the voice (auto-ducking)
      </label>
    </section>
  );
}

function Num({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Input
        type="number"
        step={0.1}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(round2(Math.min(max, Math.max(min, v))));
        }}
        className="h-8 rounded-lg tabular-nums"
      />
    </label>
  );
}
