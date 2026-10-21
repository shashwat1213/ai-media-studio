import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { requireAuth } from '../auth/require-auth.js';
import { CreateItemSchema, UpdateItemSchema, type LibraryService } from './library.js';

const Kind = z.enum(['CHARACTER', 'PLACE', 'STYLE', 'VOICE', 'SOUND']);
const IdParam = z.object({ id: z.string().uuid() });
const parseId = (p: unknown) => {
  const r = IdParam.safeParse(p);
  if (!r.success) throw new HttpError(404, 'Not found');
  return r.data.id;
};

export function libraryRouter(library: LibraryService, jwtSecret: string): Router {
  const router = Router();
  const auth = requireAuth(jwtSecret);

  router.get('/library', auth, async (req, res) => {
    const kind = req.query.kind ? Kind.parse(req.query.kind) : undefined;
    res.json({ items: await library.list(req.userId!, kind) });
  });
  router.post('/library', auth, async (req, res) => {
    res.status(201).json({ item: await library.create(req.userId!, CreateItemSchema.parse(req.body)) });
  });
  router.patch('/library/:id', auth, async (req, res) => {
    res.json({ item: await library.update(req.userId!, parseId(req.params), UpdateItemSchema.parse(req.body)) });
  });
  router.delete('/library/:id', auth, async (req, res) => {
    await library.remove(req.userId!, parseId(req.params));
    res.status(204).end();
  });
  /** Preview what a prompt's @mentions resolve to (the composer highlights unknown ones). */
  router.post('/library/resolve', auth, async (req, res) => {
    const { text } = z.object({ text: z.string().max(4000) }).parse(req.body);
    res.json(await library.resolve(req.userId!, text));
  });

  return router;
}
