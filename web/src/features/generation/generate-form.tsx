import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Coins, Loader2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { ApiError, type ModelCatalog } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useGenerate } from './use-generation';

// Mirrors the API's Zod schema, so users see the same rules before the request is even sent.
const schema = z.object({
  prompt: z.string().trim().min(3, 'Describe the image in at least 3 characters').max(1000, 'Keep it under 1000 characters'),
  model: z.string().min(1, 'Pick a model'),
  aspectRatio: z.string().min(1),
});
type Values = z.infer<typeof schema>;

const MAX = 1000;

interface Props {
  catalog: ModelCatalog;
  balance: number;
  onCreated?: (jobId: string) => void;
}

export function GenerateForm({ catalog, balance, onCreated }: Props) {
  const generate = useGenerate();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { prompt: '', model: catalog.models[1]?.id ?? catalog.models[0]?.id ?? '', aspectRatio: '1:1' },
  });

  // useWatch (not form.watch) subscribes this component to just these fields, the React-safe way.
  const [modelId, prompt] = useWatch({ control: form.control, name: ['model', 'prompt'] });
  const selected = catalog.models.find((m) => m.id === modelId);
  const cost = selected?.credits ?? 0;
  const tooPoor = balance < cost;
  const length = prompt.length;

  async function submit(values: Values) {
    try {
      const { job } = await generate.mutateAsync(values);
      toast.success('Generation started', { description: `${cost} credits reserved. Refunded automatically if it fails.` });
      form.resetField('prompt');
      onCreated?.(job.id);
    } catch (err) {
      if (err instanceof ApiError && err.details?.prompt) {
        form.setError('prompt', { message: err.details.prompt[0] });
      } else {
        // 402 / 429 / 503 messages from the API are already written for humans.
        toast.error(err instanceof Error ? err.message : 'Something went wrong');
      }
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-6" noValidate>
        <FormField
          control={form.control}
          name="prompt"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Prompt</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  rows={4}
                  maxLength={MAX}
                  placeholder="A red panda astronaut floating above Earth, soft studio lighting, 35mm photo"
                  className="resize-none"
                  onKeyDown={(e) => {
                    // Ctrl/Cmd + Enter submits, like most chat/AI tools.
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void form.handleSubmit(submit)();
                  }}
                />
              </FormControl>
              <div className="flex justify-between text-xs text-muted-foreground">
                <FormMessage />
                <span className={cn('ml-auto tabular-nums', length > MAX * 0.9 && 'text-amber-600')}>
                  {length}/{MAX}
                </span>
              </div>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="model"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Model</FormLabel>
              <div role="radiogroup" aria-label="Model" className="grid gap-3 sm:grid-cols-3">
                {catalog.models.map((m) => {
                  const active = field.value === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => field.onChange(m.id)}
                      className={cn(
                        'rounded-lg border bg-background p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active ? 'border-primary ring-1 ring-primary' : 'hover:border-foreground/20',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{m.name}</span>
                        <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-amber-600">
                          <Coins className="size-3.5" />
                          {m.credits}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{m.description}</p>
                    </button>
                  );
                })}
              </div>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="aspectRatio"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Aspect ratio</FormLabel>
              <FormControl>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={field.value}
                  // Radix sends '' when the active item is clicked again: keep a value selected.
                  onValueChange={(v) => v && field.onChange(v)}
                  className="justify-start"
                >
                  {catalog.aspectRatios.map((r) => (
                    <ToggleGroupItem key={r} value={r} className="px-3 tabular-nums" aria-label={`Aspect ratio ${r}`}>
                      {r}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </FormControl>
            </FormItem>
          )}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="lg" disabled={generate.isPending || tooPoor}>
            {generate.isPending ? <Loader2 className="animate-spin" /> : <Wand2 />}
            Generate · {cost} credits
          </Button>
          <FormDescription className={cn(tooPoor && 'text-destructive')}>
            {tooPoor
              ? `Not enough credits: you have ${balance}, this costs ${cost}.`
              : `You have ${balance} credits. Tip: Ctrl + Enter to generate.`}
          </FormDescription>
        </div>
      </form>
    </Form>
  );
}
