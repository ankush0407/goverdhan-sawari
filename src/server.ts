import express from 'express';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Engine, defaultConfig, type Config } from './flow.js';
import { CloudSender, MemorySender, parseWebhook, verifySignature, type Incoming, type Sender } from './whatsapp.js';
import { TelegramBot } from './telegram.js';

const env = process.env;
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

const cfg: Config = {
  ...defaultConfig,
  brand: env.BRAND ?? defaultConfig.brand,
  parikramaFarePerSeat: num(env.PARIKRAMA_FARE_PER_SEAT, defaultConfig.parikramaFarePerSeat),
  quoteWindowSec: num(env.QUOTE_WINDOW_SEC, defaultConfig.quoteWindowSec),
  chooseWindowSec: num(env.CHOOSE_WINDOW_SEC, defaultConfig.chooseWindowSec),
  nearbyKm: num(env.NEARBY_KM, defaultConfig.nearbyKm),
  wideKm: num(env.WIDE_KM, defaultConfig.wideKm),
  feedbackDelaySec: num(env.FEEDBACK_DELAY_SEC, defaultConfig.feedbackDelaySec),
  adminPhone: env.ADMIN_PHONE,
};

const cloud = Boolean(env.WA_PHONE_NUMBER_ID && env.WA_TOKEN);
const db = openDb(env.DB_PATH ?? './data.sqlite');
// Telegram is a stand-in for WhatsApp while Meta approval is pending; WhatsApp wins if both are configured.
const telegram = !cloud && env.TELEGRAM_BOT_TOKEN ? new TelegramBot(env.TELEGRAM_BOT_TOKEN, db) : undefined;
const memory = new MemorySender(true);
const sender: Sender = cloud ? new CloudSender(env.WA_PHONE_NUMBER_ID!, env.WA_TOKEN!) : telegram ?? memory;
const channel = cloud ? 'Cloud API' : telegram ? 'TELEGRAM' : 'DEV SIMULATOR (no WA_* env set)';
const engine = new Engine(db, sender, cfg);
if (telegram) {
  telegram.run((m) => {
    console.log(`[in] +${m.from} ${m.kind}${m.replyId ? ` ${m.replyId}` : ''}`); // who and what kind, never the content
    return engine.handle(m);
  }).catch((e) => {
    console.error('[tg] could not start — check TELEGRAM_BOT_TOKEN', e);
    process.exit(1);
  });
}

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

app.get('/health', (_req, res) => res.json({ ok: true, whatsapp: cloud ? 'cloud' : telegram ? 'telegram' : 'dev-simulator' }));

// ---------- WhatsApp webhook ----------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.WA_VERIFY_TOKEN) {
    return res.status(200).send(String(req.query['hub.challenge']));
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (env.WA_APP_SECRET && !verifySignature((req as any).rawBody ?? Buffer.alloc(0), req.header('x-hub-signature-256'), env.WA_APP_SECRET)) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack fast; Meta retries on slow responses
  const msgs = parseWebhook(req.body);
  void (async () => {
    for (const m of msgs) {
      try { await engine.handle(m); } catch (e) { console.error('[handle]', m.from, e); }
    }
  })();
});

// ---------- Admin ----------
const admin = express.Router();
admin.use((req, res, next) => {
  if (!env.ADMIN_TOKEN || req.header('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return res.sendStatus(401);
  next();
});
admin.get('/drivers', (req, res) => {
  const status = String(req.query.status ?? 'pending');
  res.json(db.prepare('SELECT phone,name,vehicle_no,seats,status,on_duty,rides_done,rating_sum,rating_count,photo_media_id,rc_media_id FROM drivers WHERE status=?').all(status));
});
admin.post('/drivers/:phone/approve', async (req, res) => res.json({ ok: await engine.approveDriver(req.params.phone) }));
admin.post('/drivers/:phone/reject', async (req, res) => res.json({ ok: await engine.rejectDriver(req.params.phone) }));

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

admin.get('/rides.csv', (_req, res) => {
  const rows = db.prepare(`SELECT r.id, r.kind, r.status, r.drop_text, r.group_size, r.when_text, r.fixed_fare, r.agreed_fare, r.final_fare, r.pay_mode,
      r.cancelled_by, r.cancel_reason, r.rider_confirmed, r.t_requested, r.t_accepted, r.t_arrived, r.t_started, r.t_completed,
      r.rider_phone, r.driver_phone,
      (SELECT rating FROM ratings WHERE ride_id=r.id AND from_role='rider') rider_rating,
      (SELECT tag FROM ratings WHERE ride_id=r.id AND from_role='rider') rider_tag,
      (SELECT COUNT(*) FROM quotes WHERE ride_id=r.id AND status IN ('sent','won','lost')) quotes_received
    FROM rides r ORDER BY r.id`).all() as Record<string, unknown>[];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.type('text/csv').send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
});
app.use('/admin', admin);

// ---------- Dev simulator (only when neither WhatsApp nor Telegram is configured) ----------
if (!cloud && !telegram) {
  // Inbound messages, each tagged with the outbox length at send time so /sim/chat can interleave both sides.
  const simInbox: { at: number; m: Incoming }[] = [];
  app.post('/sim/send', async (req, res) => {
    const b = req.body ?? {};
    const m: Incoming = {
      id: `sim-${Date.now()}-${Math.random()}`, from: String(b.from), name: b.name,
      kind: b.replyId ? 'reply' : b.lat != null ? 'location' : b.mediaId ? 'image' : 'text',
      text: b.text, replyId: b.replyId, lat: b.lat, lng: b.lng, mediaId: b.mediaId,
    };
    simInbox.push({ at: memory.outbox.length, m });
    try { await engine.handle(m); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });
  app.get('/sim/outbox', (req, res) => res.json(req.query.to ? memory.to(String(req.query.to)) : memory.outbox));
  app.get('/sim/chat', (req, res) => {
    const phone = String(req.query.phone ?? '');
    const items: object[] = [];
    let i = 0;
    const flushInbox = (upTo: number) => {
      for (; i < simInbox.length && simInbox[i].at <= upTo; i++) if (simInbox[i].m.from === phone) items.push({ dir: 'in', ...simInbox[i].m });
    };
    memory.outbox.forEach((o, k) => { flushInbox(k); if (o.to === phone) items.push({ dir: 'out', ...o }); });
    flushInbox(Infinity);
    res.json(items);
  });
  app.get('/sim', (_req, res) => res.sendFile(fileURLToPath(new URL('../public/sim.html', import.meta.url))));
}

const port = num(env.PORT, 3000);
app.listen(port, () => {
  console.log(`[goverdhan-sawari] listening on :${port} — channel: ${channel}`);
  if (!cloud && !telegram) console.log(`[goverdhan-sawari] chat simulator UI: http://localhost:${port}/sim`);
  if (!env.ADMIN_TOKEN) console.warn('[warn] ADMIN_TOKEN not set — admin API disabled');
  if (cloud && !env.WA_APP_SECRET) console.warn('[warn] WA_APP_SECRET not set — webhook signatures are NOT verified');
});
setInterval(() => { engine.tick().catch((e) => console.error('[tick]', e)); }, 5000);
