import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { motion } from 'framer-motion';
import { ArrowRight, Clapperboard, Coins, Layers, RotateCcw, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { Aurora } from '@/components/fx/aurora';
import { Button } from '@/components/ui/button';
import { useSpotlight } from '@/lib/use-spotlight';
import { useModels } from '@/features/generation/use-generation';

const PROMPTS = [
  'a lone astronaut in a field of glowing violet flowers, 35mm film',
  'neon-lit Tokyo alley in the rain, cinematic, reflections',
  'a glass whale floating above the clouds at golden hour',
  'macro shot of a dew drop on a fern, soft bokeh',
];

/** Prompt "showcase" tiles. Pure CSS art, so the landing page loads instantly and costs nothing. */
const TILES = [
  { p: 'Cyberpunk skyline', g: 'from-fuchsia-500/70 via-violet-600/60 to-indigo-900' },
  { p: 'Desert at dusk', g: 'from-amber-400/70 via-rose-500/60 to-purple-900' },
  { p: 'Deep ocean bloom', g: 'from-cyan-400/60 via-blue-600/60 to-violet-950' },
  { p: 'Forest spirits', g: 'from-emerald-400/60 via-teal-700/60 to-slate-950' },
  { p: 'Chrome portrait', g: 'from-slate-200/60 via-violet-400/50 to-zinc-900' },
  { p: 'Aurora lake', g: 'from-lime-300/50 via-violet-500/60 to-indigo-950' },
  { p: 'Paper city', g: 'from-orange-300/60 via-pink-500/50 to-violet-950' },
  { p: 'Nebula garden', g: 'from-pink-400/70 via-purple-600/60 to-black' },
];

const FEATURES = [
  { icon: Zap, title: 'Fast, in the background', body: 'Jobs run on a queue + worker. Click generate and keep working; images appear the moment they finish.' },
  { icon: Coins, title: 'Pay per image', body: 'Credits, not subscriptions. Each model shows its price up front, and you start with 50 free.' },
  { icon: RotateCcw, title: 'Automatic refunds', body: "If a generation fails, your credits come back. Exactly once, guaranteed by the database." },
  { icon: Clapperboard, title: 'Images that move', body: 'Turn any image into a short cinematic clip: push in, pan, crane up or drift. Preview the move live before rendering.' },
  { icon: Layers, title: 'Your private gallery', body: 'Every image and video is stored privately and served through short-lived signed links.' },
  { icon: ShieldCheck, title: 'Safe by design', body: 'httpOnly sessions, rate limits, and per-user isolation on every request.' },
];

function useTypewriter(lines: string[], speed = 38, hold = 1800) {
  const [i, setI] = useState(0);
  const [n, setN] = useState(0);
  useEffect(() => {
    const line = lines[i % lines.length]!;
    const t = setTimeout(
      () => {
        if (n < line.length) setN(n + 1);
        else {
          setN(0);
          setI(i + 1);
        }
      },
      n < line.length ? speed : hold,
    );
    return () => clearTimeout(t);
  }, [i, n, lines, speed, hold]);
  return lines[i % lines.length]!.slice(0, n);
}

function FeatureCard({ icon: Icon, title, body, i }: (typeof FEATURES)[number] & { i: number }) {
  const onMove = useSpotlight<HTMLDivElement>();
  return (
    <motion.div
      onPointerMove={onMove}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ delay: i * 0.05 }}
      className="spotlight rounded-2xl border bg-card/60 p-6"
    >
      <div className="mb-4 grid size-10 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
        <Icon className="size-5" />
      </div>
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </motion.div>
  );
}

export function LandingPage() {
  const typed = useTypewriter(PROMPTS);
  // Honest badge: only claim FLUX when the server really runs it.
  const mode = useModels().data?.mode;
  const badge = mode === 'cloudflare' ? 'Powered by FLUX' : mode === 'openrouter' ? 'Recraft · Seedream · Qwen' : 'AI image studio';

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <header className="relative z-20 mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
        <Logo className="hidden sm:inline-flex" />
        <Logo compact className="sm:hidden" />
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/login">Log in</Link>
          </Button>
          <Button asChild size="sm" className="btn-glow rounded-xl">
            <Link to="/register">
              <span className="sm:hidden">Sign up free</span>
              <span className="hidden sm:inline">Get 50 free credits</span>
            </Link>
          </Button>
        </div>
      </header>

      <section className="relative isolate px-5 pb-20 pt-16 sm:pt-24">
        <Aurora />
        <div className="relative mx-auto max-w-4xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-muted-foreground"
          >
            <Sparkles className="size-3.5 text-primary" />
            {badge}
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05, duration: 0.5 }}
            className="text-gradient text-5xl font-semibold leading-[1.02] tracking-tight sm:text-7xl"
          >
            Turn words
            <br />
            into images.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground"
          >
            Describe anything. Your studio renders it in seconds, keeps it in a private gallery, and only charges for
            what works.
          </motion.p>

          {/* Fake composer: a preview of the real one, typing example prompts. */}
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="glass mx-auto mt-10 flex max-w-2xl items-center gap-3 rounded-2xl p-2 pl-5 text-left shadow-[0_30px_80px_-30px_var(--glow)]"
          >
            <Sparkles className="size-5 shrink-0 text-primary" />
            <p className="min-h-6 flex-1 truncate font-mono text-sm text-foreground/90">
              {typed}
              <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-primary" />
            </p>
            <Button asChild size="lg" className="btn-glow shrink-0 rounded-xl">
              <Link to="/register">
                Generate
                <ArrowRight />
              </Link>
            </Button>
          </motion.div>
          <p className="mt-3 text-xs text-muted-foreground">No card needed · 50 credits on sign up</p>
        </div>
      </section>

      {/* Infinite marquee of style tiles */}
      <section aria-label="Styles" className="relative py-6 [mask-image:linear-gradient(90deg,transparent,black_10%,black_90%,transparent)]">
        <motion.div
          className="flex w-max gap-4"
          animate={{ x: ['0%', '-50%'] }}
          transition={{ duration: 40, ease: 'linear', repeat: Infinity }}
        >
          {[...TILES, ...TILES].map((t, i) => (
            <div
              key={i}
              className={`relative h-56 w-44 shrink-0 overflow-hidden rounded-2xl bg-gradient-to-br ${t.g} ring-1 ring-white/10 sm:h-72 sm:w-56`}
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_40%)] mix-blend-overlay" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 pt-10 text-xs font-medium">{t.p}</div>
            </div>
          ))}
        </motion.div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-24">
        <div className="mb-12 max-w-2xl">
          <p className="text-sm font-medium text-primary">Under the hood</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">A real studio, not a demo.</h2>
          <p className="mt-3 text-muted-foreground">Background jobs, an exact credit ledger and private storage, built like a production SaaS.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <FeatureCard key={f.title} {...f} i={i} />
          ))}
        </div>
      </section>

      <section className="px-5 pb-24">
        <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl border bg-card/60 px-6 py-16 text-center">
          <Aurora className="opacity-60" />
          <div className="relative">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-5xl">Your first image is free.</h2>
            <p className="mx-auto mt-3 max-w-md text-muted-foreground">Sign up, type a prompt, watch it render.</p>
            <Button asChild size="lg" className="btn-glow mt-8 rounded-xl">
              <Link to="/register">
                Start creating
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <footer className="border-t px-5 py-8 text-center text-xs text-muted-foreground">
        AI Media Studio · a portfolio project ·{' '}
        <a href="https://github.com/shashwat1213/ai-media-studio" className="underline-offset-4 hover:text-foreground hover:underline">
          source
        </a>
      </footer>
    </div>
  );
}
