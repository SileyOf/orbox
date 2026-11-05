import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import {
  CATEGORIES, activeTrip, addNote, deleteNotes, listNotes, markReimbursed, noteInput, quickNote, setTrip, summarize, toCsv, updateNote,
} from '../notes/service.js';

const month = z.string().regex(/^\d{4}-\d{2}$/);
const filter = z.object({
  month: month.optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(30).optional(),
  reimbursable: z.enum(['1', '0']).transform((v) => v === '1').optional(),
});
const ids = z.object({ ids: z.array(z.number().int()).min(1).max(1000) });

export async function noteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/notes', async (req) => {
    const f = filter.parse(req.query);
    const notes = await listNotes(req.user.id, f);
    return { notes, summary: summarize(notes), trip: activeTrip(req.user), categories: CATEGORIES };
  });

  app.get('/api/notes/export.csv', async (req, reply) => {
    const f = filter.parse(req.query);
    const csv = toCsv(await listNotes(req.user.id, { ...f, limit: 5000 }));
    const name = `orbox-notes-${f.month || f.tag || 'all'}.csv`.replace(/[^\w.-]/g, '_');
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}"`).send(csv);
  });

  app.post('/api/notes', async (req) => addNote(req.user, { ...noteInput.parse(req.body), source: 'web' }));

  /** 一句话记一笔，和机器人里"记 …"是同一套解析 */
  app.post('/api/notes/quick', async (req) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body);
    return quickNote(req.user, text, 'web');
  });

  app.patch<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
    const note = await updateNote(req.user.id, Number(req.params.id), noteInput.partial().parse(req.body));
    return note ?? reply.code(404).send({ error: '记录不存在' });
  });

  app.post('/api/notes/delete', async (req) => ({ count: await deleteNotes(req.user.id, ids.parse(req.body).ids) }));

  app.post('/api/notes/reimbursed', async (req) => {
    const body = ids.extend({ value: z.boolean() }).parse(req.body);
    return { count: await markReimbursed(req.user.id, body.ids, body.value) };
  });

  /** 开始 / 结束出差 */
  app.put('/api/notes/trip', async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(30), start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable().parse(req.body ?? null);
    await setTrip(req.user, body);
    return { trip: activeTrip(req.user) };
  });
}
