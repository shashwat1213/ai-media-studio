import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/brand/logo';
import { Aurora } from '@/components/fx/aurora';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { credentialsSchema, type Credentials } from './schemas';
import { DemoButton } from './demo-button';

interface Props {
  mode: 'login' | 'register';
  onSubmit: (values: Credentials) => Promise<unknown>;
}

const copy = {
  login: {
    title: 'Welcome back',
    description: 'Log in to keep creating.',
    submit: 'Log in',
    alt: { text: "Don't have an account?", link: 'Sign up', to: '/register' },
  },
  register: {
    title: 'Create your account',
    description: 'Start with 50 free credits.',
    submit: 'Create account',
    alt: { text: 'Already have an account?', link: 'Log in', to: '/login' },
  },
} as const;

export function AuthForm({ mode, onSubmit }: Props) {
  const c = copy[mode];
  const form = useForm<Credentials>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: '', password: '' },
  });

  async function submit(values: Credentials) {
    try {
      await onSubmit(values);
    } catch (err) {
      // Map server errors onto the form: field errors -> under the field, others -> form-level.
      if (err instanceof ApiError && err.details) {
        for (const [field, msgs] of Object.entries(err.details)) {
          if (field === 'email' || field === 'password') form.setError(field, { message: msgs?.[0] });
        }
      } else {
        form.setError('root', { message: err instanceof Error ? err.message : 'Something went wrong' });
      }
    }
  }

  const { isSubmitting, errors } = form.formState;

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left: brand panel (desktop only) */}
      <div className="relative hidden overflow-hidden border-r lg:block">
        <Aurora />
        <div className="relative flex h-full flex-col justify-between p-10">
          <Link to="/">
            <Logo />
          </Link>
          <div className="max-w-md">
            <p className="text-gradient text-4xl font-semibold leading-tight tracking-tight">
              {mode === 'register' ? 'Your studio is one step away.' : 'Pick up where you left off.'}
            </p>
            <p className="mt-4 text-muted-foreground">
              Type a prompt, get an image. Credits are reserved up front and refunded automatically if anything fails.
            </p>
            <div className="mt-8 grid grid-cols-3 gap-3">
              {['from-fuchsia-500/70 to-indigo-900', 'from-amber-400/60 to-purple-900', 'from-cyan-400/60 to-violet-950'].map((g, i) => (
                <motion.div
                  key={g}
                  className={`aspect-[3/4] rounded-xl bg-gradient-to-br ${g} ring-1 ring-white/10`}
                  animate={{ y: [0, i % 2 ? 8 : -8, 0] }}
                  transition={{ duration: 6 + i, repeat: Infinity, ease: 'easeInOut' }}
                />
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">© AI Media Studio</p>
        </div>
      </div>

      {/* Right: the form */}
      <div className="relative flex items-center justify-center p-6">
        <div aria-hidden className="absolute inset-0 bg-[radial-gradient(50%_40%_at_50%_0%,oklch(0.55_0.25_293/16%),transparent)] lg:hidden" />
        <motion.div
          className="relative w-full max-w-sm"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <Link to="/" className="mb-10 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" />
            Back
          </Link>
          <div className="mb-8 lg:hidden">
            <Logo />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">{c.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{c.description}</p>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit)} noValidate className="mt-8 space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="email" placeholder="you@example.com" className="h-11 rounded-xl" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                        placeholder={mode === 'register' ? 'At least 8 characters' : undefined}
                        className="h-11 rounded-xl"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {errors.root && (
                <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {errors.root.message}
                </p>
              )}
              <Button type="submit" size="lg" className="btn-glow h-11 w-full rounded-xl" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="animate-spin" />}
                {c.submit}
              </Button>
              <p className="pt-2 text-center text-sm text-muted-foreground">
                {c.alt.text}{' '}
                <Link to={c.alt.to} className="font-medium text-foreground underline-offset-4 hover:underline">
                  {c.alt.link}
                </Link>
              </p>
            </form>
          </Form>
          <div className="mt-6 border-t pt-6">
            <DemoButton className="h-11 w-full rounded-xl" label="Just looking? Try the demo account" />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
