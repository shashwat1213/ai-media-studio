import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cookieOf, fakeQueue, prisma, resetDb, testConfig } from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { parseMentions } from './library.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const app = createApp({ prisma, config: testConfig, queue: fakeQueue() });
async function user() {
  const email = `l${Math.random()}@example.com`;
  return cookieOf(await request(app).post('/auth/register').send({ email, password: 'password-123' }));
}

describe('parseMentions (pure)', () => {
  it('finds @handles, lower-cases, dedupes, ignores emails and too-short handles', () => {
    expect(parseMentions('@Riya walks on @goa_beach, then @riya smiles. mail me@x.com @a')).toEqual(['riya', 'goa_beach']);
    expect(parseMentions('no mentions')).toEqual([]);
  });
});

describe('library API', () => {
  it('create -> list -> update -> delete; settings validated per kind, unknown keys stripped', async () => {
    const c = await user();
    const riya = await request(app)
      .post('/library')
      .set('Cookie', c)
      .send({ kind: 'CHARACTER', handle: '  Riya ', name: 'Riya', description: '25, curly hair, yellow kurta', settings: { seed: 42, junk: 1 } })
      .expect(201);
    expect(riya.body.item).toMatchObject({ kind: 'CHARACTER', handle: 'riya', settings: { seed: 42 } });
    expect(riya.body.item.settings).not.toHaveProperty('junk');

    await request(app).post('/library').set('Cookie', c).send({ kind: 'VOICE', handle: 'narrator', name: 'Narrator', settings: { engine: 'piper', voice: 'hi_IN-rohan-medium', language: 'hi' } }).expect(201);
    expect((await request(app).post('/library').set('Cookie', c).send({ kind: 'VOICE', handle: 'bad', name: 'x', settings: { engine: 'gpt', voice: 'x', language: 'hi' } })).status).toBe(400);

    const list = await request(app).get('/library').set('Cookie', c).expect(200);
    expect(list.body.items.map((i: { handle: string }) => i.handle)).toEqual(['riya', 'narrator']); // CHARACTER < VOICE
    expect((await request(app).get('/library?kind=VOICE').set('Cookie', c)).body.items).toHaveLength(1);

    const upd = await request(app).patch(`/library/${riya.body.item.id}`).set('Cookie', c).send({ description: 'now in a red saree', settings: { voice: 'narrator' } }).expect(200);
    expect(upd.body.item).toMatchObject({ description: 'now in a red saree', settings: { seed: 42, voice: 'narrator' } });
    expect((await request(app).patch(`/library/${riya.body.item.id}`).set('Cookie', c).send({ settings: { seed: -1 } })).status).toBe(400);

    await request(app).delete(`/library/${riya.body.item.id}`).set('Cookie', c).expect(204);
    await request(app).delete(`/library/${riya.body.item.id}`).set('Cookie', c).expect(404);
  });

  it('handles: unique per user (409), bad handles rejected, other users can reuse them', async () => {
    const a = await user();
    const b = await user();
    const item = { kind: 'PLACE', handle: 'goa', name: 'Goa beach', description: 'sunset, palms' };
    await request(app).post('/library').set('Cookie', a).send(item).expect(201);
    expect((await request(app).post('/library').set('Cookie', a).send({ ...item, kind: 'STYLE' })).body.error).toMatch(/@goa is already used/);
    await request(app).post('/library').set('Cookie', b).send(item).expect(201);
    for (const handle of ['a', 'has space', 'x'.repeat(33), 'émoji']) {
      expect((await request(app).post('/library').set('Cookie', a).send({ ...item, handle })).status).toBe(400);
    }
  });

  it("isolation: no reading/editing/deleting another user's items; resolve only sees your own", async () => {
    const a = await user();
    const b = await user();
    const { body } = await request(app).post('/library').set('Cookie', a).send({ kind: 'CHARACTER', handle: 'riya', name: 'Riya', description: 'curly hair' }).expect(201);
    await request(app).patch(`/library/${body.item.id}`).set('Cookie', b).send({ name: 'hacked' }).expect(404);
    await request(app).delete(`/library/${body.item.id}`).set('Cookie', b).expect(404);
    expect((await request(app).get('/library').set('Cookie', b)).body.items).toEqual([]);

    const ra = await request(app).post('/library/resolve').set('Cookie', a).send({ text: '@riya meets @ghost' }).expect(200);
    expect(ra.body.items.map((i: { handle: string }) => i.handle)).toEqual(['riya']);
    expect(ra.body.unknown).toEqual(['ghost']);
    expect((await request(app).post('/library/resolve').set('Cookie', b).send({ text: '@riya' })).body.unknown).toEqual(['riya']);
    await request(app).get('/library').expect(401);
  });

  it('referenced files must be your own READY uploads', async () => {
    const a = await user();
    const r = await request(app)
      .post('/library')
      .set('Cookie', a)
      .send({ kind: 'SOUND', handle: 'waves', name: 'Waves', settings: { uploadId: '00000000-0000-4000-8000-000000000009', tags: ['beach'] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/file not found/);
  });

  it('DB backs the rules: a lower-case slug handle and an object settings column', async () => {
    const u = await prisma.user.create({ data: { email: `db${Math.random()}@x.com`, passwordHash: 'x' } });
    await expect(prisma.libraryItem.create({ data: { userId: u.id, kind: 'PLACE', handle: 'Bad Handle', name: 'x', description: '' } })).rejects.toThrow(/LibraryItem_handle_check/);
    await expect(prisma.libraryItem.create({ data: { userId: u.id, kind: 'PLACE', handle: 'ok', name: 'x', description: '', settings: [] } })).rejects.toThrow(/settings_object_check/);
  });
});
