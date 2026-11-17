// Admin API: JSON behind ADMIN_TOKEN for the dashboard (public/admin.html), plus the original
// driver / stats / CSV endpoints. Mounted at /admin by server.ts.
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { DB } from './db.js';
import type { Engine } from './flow.js';
import type { Sender } from './whatsapp.js';

type Deps = {
  db: DB; engine: Engine; sender: Sender; token: string | undefined;
  /** Wrong tokens allowed per address within the window before it is locked out (the correct token is refused too). */
  maxFailures?: number; windowMs?: number;
};

/** Epoch ms → "2026-11-17 14:03:20" in India time, for the CSV and anything a person reads. */
export const ist = (ms: number | null | undefined) =>
  ms == null ? '' : new Date(ms + 5.5 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const parseJson = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export function createAdminRouter({ db, engine, sender, token, maxFailures = 10, windowMs = 15 * 60_000 }: Deps) {
  const admin = express.Router();

  // On a public host anyone can try tokens, so repeated wrong ones lock that address out for a while.
  const failures = new Map<string, number[]>(); // address → times of recent wrong tokens
  admin.use((req, res, next) => {
    const ip = req.ip ?? 'unknown', now = Date.now();
    if (failures.size > 1000) for (const [k, v] of failures) if (v.every((t) => now - t >= windowMs)) failures.delete(k);
    const recent = (failures.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= maxFailures) {
      failures.set(ip, recent);
      return res.set('Retry-After', String(Math.ceil(windowMs / 1000))).sendStatus(429);
    }
    if (!token || !safeEq(req.header('authorization') ?? '', `Bearer ${token}`)) {
      failures.set(ip, [...recent, now]);
      return res.sendStatus(401);
    }
    failures.delete(ip);
    next();
  });

  // ---------- drivers ----------
  /** ?status=pending (default) | approved | rejected | draft | all */
  admin.get('/drivers', (req, res) => {
    const status = String(req.query.status ?? 'pending');
    const where = status === 'all' ? '' : 'WHERE d.status=?';
    res.json(db.prepare(`SELECT d.phone, d.name, d.vehicle_no, d.seats, d.status, d.on_duty, d.rides_done, d.rating_sum, d.rating_count,
        d.photo_media_id, d.rc_media_id, d.lat, d.lng, d.loc_at, d.created_at, u.state AS signup_step, u.name AS chat_name
      FROM drivers d LEFT JOIN users u ON u.phone=d.phone ${where}
      ORDER BY d.created_at DESC, d.rowid DESC`).all(...(where ? [status] : [])));
  });
  admin.post('/drivers/:phone/approve', async (req, res) => res.json({ ok: await engine.approveDriver(req.params.phone) }));
  admin.post('/drivers/:phone/reject', async (req, res) => res.json({ ok: await engine.rejectDriver(req.params.phone) }));

  /** A driver's uploaded photo or RC, fetched from the chat platform. Looked up by phone, never by a caller-supplied file id. */
  admin.get('/media/:kind/:phone', async (req, res) => {
    const col = req.params.kind === 'photo' ? 'photo_media_id' : req.params.kind === 'rc' ? 'rc_media_id' : undefined;
    if (!col) return res.sendStatus(404);
    const row = db.prepare(`SELECT ${col} AS id FROM drivers WHERE phone=?`).get(req.params.phone) as { id: string | null } | undefined;
    if (!row?.id || !sender.media) return res.sendStatus(404);
    const file = await sender.media(row.id);
    if (!file) return res.sendStatus(404);
    if (!/^image\/(jpeg|png|webp)$/.test(file.contentType)) return res.sendStatus(415);
    res.set({ 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' }).type(file.contentType).send(file.data);
  });

  // ---------- riders ----------
  admin.get('/riders', (_req, res) => {
    res.json(db.prepare(`SELECT u.phone, u.name, u.lang, u.created_at,
        COUNT(r.id) AS rides,
        COALESCE(SUM(r.status='completed'), 0) AS completed,
        COALESCE(SUM(r.status='cancelled'), 0) AS cancelled,
        MAX(r.t_requested) AS last_ride_at
      FROM users u LEFT JOIN rides r ON r.rider_phone=u.phone
      WHERE u.phone NOT IN (SELECT phone FROM drivers)
      GROUP BY u.phone
      ORDER BY COALESCE(MAX(r.t_requested), u.created_at) DESC`).all());
  });

  // ---------- rides ----------
  /** Newest first. The start code (otp) is deliberately not included. */
  admin.get('/rides', (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1), 1000);
    res.json(db.prepare(`SELECT r.id, r.kind, r.status, r.rider_phone, COALESCE(ru.name, r.rider_name) AS rider_name,
        r.driver_phone, d.name AS driver_name, r.pickup_text, r.pickup_lat, r.pickup_lng, r.drop_key, r.drop_text,
        r.group_size, r.when_text, r.fixed_fare, r.agreed_fare, r.final_fare, r.pay_mode,
        r.cancelled_by, r.cancel_reason, r.rider_confirmed,
        r.t_requested, r.t_accepted, r.t_arrived, r.t_started, r.t_completed, r.t_cancelled,
        rr.rating AS rider_rating, rr.tag AS rider_tag, rr.note AS rider_note, rr.note_media_id IS NOT NULL AS rider_voice_note,
        dr.rating AS driver_thumb,
        (SELECT COUNT(*) FROM quotes q WHERE q.ride_id=r.id AND q.status IN ('sent','won','lost')) AS quotes_received
      FROM rides r
      LEFT JOIN users ru ON ru.phone=r.rider_phone
      LEFT JOIN drivers d ON d.phone=r.driver_phone
      LEFT JOIN ratings rr ON rr.ride_id=r.id AND rr.from_role='rider'
      LEFT JOIN ratings dr ON dr.ride_id=r.id AND dr.from_role='driver'
      ORDER BY r.id DESC LIMIT ?`).all(limit));
  });

  /** Everything that happened on one ride, in order, plus every quote. */
  admin.get('/rides/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM rides WHERE id=?').get(id)) return res.sendStatus(404);
    const events = (db.prepare('SELECT at, kind, data FROM events WHERE ride_id=? ORDER BY id').all(id) as { at: number; kind: string; data: string | null }[])
      .map((e) => ({ at: e.at, kind: e.kind, data: parseJson(e.data) }));
    const quotes = db.prepare(`SELECT q.driver_phone, d.name AS driver_name, q.price, q.eta_min, q.status, q.created_at, q.quoted_at
      FROM quotes q LEFT JOIN drivers d ON d.phone=q.driver_phone WHERE q.ride_id=? ORDER BY q.id`).all(id);
    res.json({ events, quotes });
  });

  // ---------- stats ----------
  admin.get('/stats', (_req, res) => {
    const one = (sql: string) => (db.prepare(sql).get() as any);
    const total = one('SELECT COUNT(*) c FROM rides').c as number;
    const byStatus = db.prepare('SELECT status, COUNT(*) c FROM rides GROUP BY status').all();
    const completed = one("SELECT COUNT(*) c FROM rides WHERE status='completed'").c as number;
    const matched = one('SELECT COUNT(*) c FROM rides WHERE t_accepted IS NOT NULL').c as number;
    const ttf = (db.prepare(`SELECT (MIN(q.quoted_at) - r.t_requested)/1000.0 s FROM rides r JOIN quotes q ON q.ride_id=r.id
      WHERE q.quoted_at IS NOT NULL GROUP BY r.id`).all() as { s: number }[]).map((x) => x.s).sort((a, b) => a - b);
    const medianTtf = ttf.length ? ttf[Math.floor(ttf.length / 2)] : null;
    res.json({
      rides: { total, byStatus, matchRate: total ? matched / total : null, completionRate: total ? completed / total : null },
      fareTotalRupees: one("SELECT COALESCE(SUM(final_fare),0) s FROM rides WHERE status='completed'").s,
      avgQuotesPerQuoteRide: one("SELECT AVG(n) a FROM (SELECT COUNT(*) n FROM quotes q JOIN rides r ON r.id=q.ride_id WHERE r.kind='quote' AND q.status IN ('sent','won','lost') GROUP BY q.ride_id)").a,
      medianSecondsToFirstQuote: medianTtf,
      drivers: {
        approved: one("SELECT COUNT(*) c FROM drivers WHERE status='approved'").c,
        pending: one("SELECT COUNT(*) c FROM drivers WHERE status='pending'").c,
        onDutyNow: one('SELECT COUNT(*) c FROM drivers WHERE on_duty=1').c,
        withAtLeastOneRide: one('SELECT COUNT(*) c FROM drivers WHERE rides_done>0').c,
      },
      riders: {
        unique: one('SELECT COUNT(DISTINCT rider_phone) c FROM rides').c,
        repeat: one("SELECT COUNT(*) c FROM (SELECT rider_phone FROM rides WHERE status='completed' GROUP BY rider_phone HAVING COUNT(*)>=2)").c,
      },
      ratings: { riderToDriverAvg: one("SELECT AVG(rating) a FROM ratings WHERE from_role='rider'").a, driverThumbsUp: one("SELECT AVG(rating) a FROM ratings WHERE from_role='driver'").a },
      disputedByRider: one("SELECT COUNT(*) c FROM rides WHERE rider_confirmed='no'").c,
    });
  });

  // ---------- CSV ----------
  const TIME_COLS = ['t_requested', 't_accepted', 't_arrived', 't_started', 't_completed'];
  admin.get('/rides.csv', (_req, res) => {
    const rows = db.prepare(`SELECT r.id, r.kind, r.status, r.drop_text, r.group_size, r.when_text, r.fixed_fare, r.agreed_fare, r.final_fare, r.pay_mode,
        r.cancelled_by, r.cancel_reason, r.rider_confirmed, r.t_requested, r.t_accepted, r.t_arrived, r.t_started, r.t_completed,
        r.rider_phone, COALESCE(ru.name, r.rider_name) AS rider_name, r.driver_phone, d.name AS driver_name,
        (SELECT rating FROM ratings WHERE ride_id=r.id AND from_role='rider') rider_rating,
        (SELECT tag FROM ratings WHERE ride_id=r.id AND from_role='rider') rider_tag,
        (SELECT note FROM ratings WHERE ride_id=r.id AND from_role='rider') rider_note,
        (SELECT COUNT(*) FROM quotes WHERE ride_id=r.id AND status IN ('sent','won','lost')) quotes_received
      FROM rides r LEFT JOIN users ru ON ru.phone=r.rider_phone LEFT JOIN drivers d ON d.phone=r.driver_phone
      ORDER BY r.id`).all() as Record<string, unknown>[];
    for (const r of rows) for (const c of TIME_COLS) r[c] = ist(r[c] as number | null);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    res.type('text/csv').send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
  });

  return admin;
}
