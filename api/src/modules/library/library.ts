import type { LibraryItem, LibraryKind, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { HttpError, notFound, tooManyRequests } from '../../lib/errors.js';

/**
 * The user's library: characters, places, styles, voices and sounds that prompts mention with
 * @handle. Descriptions are what the Director AI sees, so "the same character" stays the same.
 */

export const LIBRARY_LIMITS = { items: 200, description: 1000 } as const;
export const HANDLE_RE = /^[a-z0-9_]{2,32}$/;

/** Kind-specific settings. Unknown keys are dropped (strip), so the JSON column stays clean. */
export const SETTINGS = {
  CHARACTER: z.object({
    /** Fixed seed for this character's pictures: same seed + same description = closer look. */
    seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
    /**
     * The item's image is used as a FACE REFERENCE (same face in every shot). Only allowed with an
     * explicit consent statement: the photo is of the user, of someone who agreed, or AI-generated.
     */
    faceRef: z.boolean().optional(),
    faceConsent: z.enum(['self', 'consented', 'ai_generated']).optional(),
    /** The voice they speak with (a VOICE item's handle). */
    voice: z.string().regex(HANDLE_RE).optional(),
  }),
  PLACE: z.object({
    /** Default ambience for scenes here (a SOUND item's handle). */
    ambience: z.string().regex(HANDLE_RE).optional(),
  }),
  STYLE: z.object({
    /** Extra words appended to every picture prompt in this style. */
    promptSuffix: z.string().max(300).optional(),
    negative: z.string().max(300).optional(),
  }),
  VOICE: z.object({
    engine: z.enum(['piper', 'aura']),
    /** Piper: hi_IN-pratham-medium… ; Aura: luna, orion… (checked against the live voice list). */
    voice: z.string().min(1).max(60),
    language: z.enum(['hi', 'en']),
    /** 0.5..2, 1 = normal speed. */
    speed: z.number().min(0.5).max(2).default(1),
  }),
  SOUND: z.object({
    /** An audio Upload of this user (a recorded or downloaded sound / music bed). */
    uploadId: z.string().uuid().optional(),
    tags: z.array(z.string().max(24)).max(12).default([]),
    /** Music beds dip under narration; ambience stays steady. */
    role: z.enum(['music', 'ambience', 'sfx']).default('ambience'),
  }),
} satisfies Record<LibraryKind, z.ZodTypeAny>;

const Base = z.object({
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(HANDLE_RE, 'Handle: 2-32 letters, numbers or _ (no spaces)'),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(LIBRARY_LIMITS.description).default(''),
  imageUploadId: z.string().uuid().nullable().optional(),
});

export const CreateItemSchema = z.discriminatedUnion('kind', [
  Base.extend({ kind: z.literal('CHARACTER'), settings: SETTINGS.CHARACTER.default({}) }),
  Base.extend({ kind: z.literal('PLACE'), settings: SETTINGS.PLACE.default({}) }),
  Base.extend({ kind: z.literal('STYLE'), settings: SETTINGS.STYLE.default({}) }),
  Base.extend({ kind: z.literal('VOICE'), settings: SETTINGS.VOICE }),
  Base.extend({ kind: z.literal('SOUND'), settings: SETTINGS.SOUND.default({}) }),
]);
export type CreateItem = z.infer<typeof CreateItemSchema>;

export const UpdateItemSchema = Base.partial().extend({ settings: z.record(z.unknown()).optional() });

/** '@riya at @goa_beach' -> ['riya', 'goa_beach'] (deduped, in order). Emails are not mentions. */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w.])@([a-zA-Z0-9_]{2,32})\b/g)) {
    const h = m[1]!.toLowerCase();
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

export type PublicItem = Pick<LibraryItem, 'id' | 'kind' | 'handle' | 'name' | 'description' | 'imageUploadId' | 'createdAt' | 'updatedAt'> & {
  settings: Record<string, unknown>;
};
const toPublic = (i: LibraryItem): PublicItem => ({
  id: i.id,
  kind: i.kind,
  handle: i.handle,
  name: i.name,
  description: i.description,
  settings: (i.settings ?? {}) as Record<string, unknown>,
  imageUploadId: i.imageUploadId,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
});

export function createLibraryService(deps: {
  prisma: PrismaClient;
  /** Validates a VOICE item's engine+voice against what's actually installed/available. */
  voiceExists?: (engine: 'piper' | 'aura', voice: string) => boolean;
}) {
  const { prisma } = deps;

  async function checkRefs(userId: string, kind: LibraryKind, settings: Record<string, unknown>, imageUploadId?: string | null) {
    if (kind === 'CHARACTER' && settings.faceRef === true) {
      if (!settings.faceConsent) throw new HttpError(400, 'A face reference needs your confirmation that the photo is you, someone who agreed, or AI-generated');
      if (!imageUploadId) throw new HttpError(400, 'A face reference needs a photo');
    }
    if (kind === 'VOICE' && deps.voiceExists) {
      const s = settings as z.infer<typeof SETTINGS.VOICE>;
      if (!deps.voiceExists(s.engine, s.voice)) throw new HttpError(400, `Voice "${s.voice}" is not available on ${s.engine}`);
    }
    const uploadIds = [imageUploadId, kind === 'SOUND' ? (settings.uploadId as string | undefined) : undefined].filter(Boolean) as string[];
    if (uploadIds.length) {
      const n = await prisma.upload.count({ where: { id: { in: uploadIds }, userId, status: 'READY' } });
      if (n !== new Set(uploadIds).size) throw new HttpError(400, 'Referenced file not found');
    }
  }

  const conflict = (err: unknown, handle: string) => {
    if ((err as { code?: string }).code === 'P2002') throw new HttpError(409, `@${handle} is already used in your library`);
    throw err;
  };

  return {
    async list(userId: string, kind?: LibraryKind) {
      const items = await prisma.libraryItem.findMany({ where: { userId, ...(kind ? { kind } : {}) }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
      return items.map(toPublic);
    },

    async create(userId: string, input: CreateItem) {
      if ((await prisma.libraryItem.count({ where: { userId } })) >= LIBRARY_LIMITS.items) {
        throw tooManyRequests(`Your library is full (${LIBRARY_LIMITS.items} items)`);
      }
      await checkRefs(userId, input.kind, input.settings as Record<string, unknown>, input.imageUploadId);
      try {
        const row = await prisma.libraryItem.create({
          data: {
            userId,
            kind: input.kind,
            handle: input.handle,
            name: input.name,
            description: input.description,
            settings: input.settings as Prisma.InputJsonValue,
            imageUploadId: input.imageUploadId ?? null,
          },
        });
        return toPublic(row);
      } catch (err) {
        return conflict(err, input.handle);
      }
    },

    async update(userId: string, id: string, patch: z.infer<typeof UpdateItemSchema>) {
      const cur = await prisma.libraryItem.findFirst({ where: { id, userId } });
      if (!cur) throw notFound('Library item not found');
      // Re-validate the merged settings against the item's kind.
      const settings = patch.settings
        ? (SETTINGS[cur.kind] as z.ZodTypeAny).parse({ ...(cur.settings as object), ...patch.settings })
        : (cur.settings as Record<string, unknown>);
      await checkRefs(userId, cur.kind, settings, patch.imageUploadId === undefined ? cur.imageUploadId : patch.imageUploadId);
      try {
        const row = await prisma.libraryItem.update({
          where: { id },
          data: {
            handle: patch.handle,
            name: patch.name,
            description: patch.description,
            imageUploadId: patch.imageUploadId,
            settings: settings as Prisma.InputJsonValue,
          },
        });
        return toPublic(row);
      } catch (err) {
        return conflict(err, patch.handle ?? cur.handle);
      }
    },

    async remove(userId: string, id: string) {
      const { count } = await prisma.libraryItem.deleteMany({ where: { id, userId } });
      if (count === 0) throw notFound('Library item not found');
    },

    /** @handles in a prompt -> the user's items (unknown handles are reported, not guessed). */
    async resolve(userId: string, text: string) {
      const handles = parseMentions(text);
      const items = handles.length ? await prisma.libraryItem.findMany({ where: { userId, handle: { in: handles } } }) : [];
      const found = new Map(items.map((i) => [i.handle, toPublic(i)]));
      return { items: handles.flatMap((h) => (found.has(h) ? [found.get(h)!] : [])), unknown: handles.filter((h) => !found.has(h)) };
    },
  };
}
export type LibraryService = ReturnType<typeof createLibraryService>;
