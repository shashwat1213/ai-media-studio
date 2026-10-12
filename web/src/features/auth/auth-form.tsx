import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router';
import { Loader2, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { credentialsSchema, type Credentials } from './schemas';

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
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <motion.div
        className="w-full max-w-sm"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <div className="mb-6 flex items-center justify-center gap-2 font-semibold">
          <Sparkles className="size-5 text-primary" />
          AI Media Studio
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{c.title}</CardTitle>
            <CardDescription>{c.description}</CardDescription>
          </CardHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit)} noValidate>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input type="email" autoComplete="email" placeholder="you@example.com" {...field} />
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
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {errors.root && (
                  <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {errors.root.message}
                  </p>
                )}
              </CardContent>
              <CardFooter className="mt-6 flex flex-col gap-3">
                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="animate-spin" />}
                  {c.submit}
                </Button>
                <p className="text-sm text-muted-foreground">
                  {c.alt.text}{' '}
                  <Link to={c.alt.to} className="font-medium text-foreground underline-offset-4 hover:underline">
                    {c.alt.link}
                  </Link>
                </p>
              </CardFooter>
            </form>
          </Form>
        </Card>
      </motion.div>
    </div>
  );
}
