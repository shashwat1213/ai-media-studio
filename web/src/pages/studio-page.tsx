import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { FlaskConical, Sparkles } from 'lucide-react';
import type { Asset, Job } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/features/auth/use-auth';
import { AssetLightbox } from '@/features/generation/asset-lightbox';
import { ImageComposer, ImageSettings, SURPRISE, useImageSettings } from '@/features/generation/image-tool';
import { JobCard } from '@/features/generation/job-card';
import { MotionSettings, MotionStage, useMotionState } from '@/features/generation/motion-tool';
import { useModels, useMotionPresets, useRecentJobs } from '@/features/generation/use-generation';
import { StudioLayout, ToolRail, type Tool } from '@/features/studio/studio-layout';
import { EditorCanvas, EditorSettings, useEditorTool } from '@/features/editor/editor-tool';
import { useEditorConfig, useUploads } from '@/features/editor/use-editor';
import { PhotoCanvas, PhotoSettings, usePhotoTool } from '@/features/photo/photo-tool';

const toAsset = (j: Job): Asset | null => (j.asset ? { ...j.asset, prompt: j.prompt, model: j.model, aspectRatio: j.aspectRatio } : null);

/**
 * The Studio: one screen, two tools. State that should survive a refresh or be shareable
 * (which tool, which source image) lives in the URL: /studio?tool=motion&src=<assetId>.
 */
export function StudioPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tool');
  const tool: Tool = raw === 'motion' || raw === 'editor' || raw === 'photo' ? raw : 'image';
  const setTool = (t: Tool, extra: Record<string, string> = {}) => setParams({ tool: t, ...extra }, { replace: false });

  const { data: user } = useMe();
  const models = useModels();
  const motionCatalog = useMotionPresets();
  const imageSettings = useImageSettings(models.data);
  const m = useMotionState(motionCatalog.data, params.get('src'), (src) => setParams({ tool: 'motion', src }, { replace: true }));

  // Remix seed: from navigation state (gallery/explore) or from a card in the feed.
  const incoming = (useLocation().state as { remix?: string } | null)?.remix;
  const [seed, setSeed] = useState<{ prompt: string; n: number } | undefined>(incoming ? { prompt: incoming, n: 0 } : undefined);
  const remix = (prompt: string) => {
    setTool('image');
    setSeed((s) => ({ prompt, n: (s?.n ?? 0) + 1 }));
  };
  const animate = (assetId: string) => {
    setTool('motion', { src: assetId });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Editor data only loads once the Editor tab is opened.
  const editorConfig = useEditorConfig();
  const uploads = useUploads();
  const editorTool = useEditorTool(uploads.data?.items);
  const photoTool = usePhotoTool(uploads.data?.items, params.get('photo'), (photo) => setParams({ tool: 'photo', photo }, { replace: true }));

  const jobs = useRecentJobs(30, tool === 'motion' ? 'MOTION' : tool === 'editor' ? 'EDIT' : 'IMAGE');
  const [open, setOpen] = useState<Asset | null>(null);
  const items = jobs.data?.items ?? [];
  const balance = user?.credits ?? 0;

  const settings =
    tool === 'photo' ? (
      editorConfig.data ? <PhotoSettings tool={photoTool} config={editorConfig.data} uploadsLoading={uploads.isLoading} /> : <PanelSkeleton />
    ) : tool === 'editor' ? (
      editorConfig.data ? (
        <EditorSettings tool={editorTool} config={editorConfig.data} uploads={uploads.data?.items ?? []} uploadsLoading={uploads.isLoading} balance={balance} />
      ) : (
        <PanelSkeleton />
      )
    ) : tool === 'image' ? (
      models.data ? (
        <ImageSettings catalog={models.data} settings={imageSettings} />
      ) : (
        <PanelSkeleton />
      )
    ) : motionCatalog.data ? (
      <MotionSettings catalog={motionCatalog.data} m={m} balance={balance} />
    ) : (
      <PanelSkeleton />
    );

  return (
    <StudioLayout rail={<ToolRail tool={tool} onChange={(t) => setTool(t)} />} settings={settings}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tool} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
          <header className="mb-4">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {tool === 'image' ? (
                <>
                  What will you <span className="text-gradient">create</span> today?
                </>
              ) : tool === 'photo' ? (
                <>
                  Make your photo <span className="text-gradient">pop</span>.
                </>
              ) : tool === 'editor' ? (
                <>
                  Turn screenshots into a <span className="text-gradient">walkthrough</span>.
                </>
              ) : (
                <>
                  Bring an image to <span className="text-gradient">life</span>.
                </>
              )}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {tool === 'image'
                ? 'Describe it. It renders in the background, so keep going.'
                : tool === 'photo'
                  ? 'Upload a photo, then crop, filter, adjust and add text. Save it to use in your videos.'
                  : tool === 'editor'
                  ? 'Upload screenshots or record your screen, add captions and highlights, then render an MP4.'
                  : 'Pick an image and a camera move. Preview it live, then render an MP4.'}
            </p>
          </header>

          {tool === 'image' ? (
            <>
              {models.isLoading || !user ? (
                <Skeleton className="h-[116px] w-full rounded-2xl" />
              ) : models.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  Couldn't load models: {models.error.message}
                </p>
              ) : (
                <ImageComposer key={seed?.n ?? -1} settings={imageSettings} balance={balance} seed={seed} />
              )}
              {models.data?.mode === 'stub' && <DemoBanner />}
            </>
          ) : tool === 'photo' ? (
            editorConfig.data ? <PhotoCanvas tool={photoTool} config={editorConfig.data} /> : <Skeleton className="aspect-video w-full rounded-2xl" />
          ) : tool === 'editor' ? (
            editorConfig.data ? (
              <EditorCanvas tool={editorTool} config={editorConfig.data} uploads={uploads.data?.items ?? []} />
            ) : (
              <Skeleton className="aspect-video w-full rounded-2xl" />
            )
          ) : motionCatalog.data ? (
            <MotionStage m={m} presets={motionCatalog.data.presets} />
          ) : (
            <Skeleton className="aspect-video w-full rounded-2xl" />
          )}

          {tool !== 'photo' && <section aria-label={tool === 'image' ? 'Your images' : tool === 'editor' ? 'Your edits' : 'Your videos'} className="mt-8">
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">{tool === 'image' ? 'Recent images' : tool === 'editor' ? 'Rendered edits' : 'Recent videos'}</h2>
            {jobs.isLoading ? (
              <div className="columns-2 gap-3 md:columns-3 xl:columns-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="mb-3 aspect-square w-full rounded-2xl" />
                ))}
              </div>
            ) : jobs.isError ? (
              <p role="alert" className="text-sm text-destructive">
                Couldn't load jobs: {jobs.error.message}
              </p>
            ) : items.length === 0 ? (
              tool === 'image' ? (
                <EmptyImages onPick={remix} />
              ) : (
                <p className="rounded-2xl border border-dashed border-white/10 py-10 text-center text-sm text-muted-foreground">
                  {tool === 'editor' ? 'Rendered edits will appear here.' : 'Your videos will appear here.'}
                </p>
              )
            ) : (
              <motion.div layout className="columns-2 gap-3 md:columns-3 xl:columns-4 [&>*]:mb-3 [&>*]:break-inside-avoid">
                {items.map((j) => (
                  <JobCard key={j.id} job={j} models={models.data?.models} onOpen={(job) => setOpen(toAsset(job))} onRemix={remix} onAnimate={animate} />
                ))}
              </motion.div>
            )}
          </section>}
        </motion.div>
      </AnimatePresence>

      <AssetLightbox asset={open} models={models.data?.models} onClose={() => setOpen(null)} onRemix={remix} onAnimate={animate} />
    </StudioLayout>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-12 w-full rounded-xl" />
    </div>
  );
}

function DemoBanner() {
  return (
    <div className="mt-4 flex items-start gap-3 rounded-xl border border-warning/20 bg-warning/[0.06] p-3 text-xs text-warning/90">
      <FlaskConical className="mt-0.5 size-4 shrink-0" />
      <p>
        <span className="font-medium">Demo mode:</span> no AI provider configured, so images are free placeholder art. The queue, worker, storage and credits
        are all real. Add <code className="rounded bg-warning/15 px-1">[fail]</code> or <code className="rounded bg-warning/15 px-1">[flaky]</code> to a prompt
        to see the automatic refund.
      </p>
    </div>
  );
}

function EmptyImages({ onPick }: { onPick: (p: string) => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 px-6 py-12 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
        <Sparkles className="size-5" />
      </div>
      <p className="mt-4 font-medium">Your canvas is empty</p>
      <p className="mt-1 text-sm text-muted-foreground">Try one of these to get started:</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {SURPRISE.slice(0, 4).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="max-w-xs truncate rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
