import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Engine, defaultConfig, type Config } from './flow.js';
import { CloudSender, MemorySender, parseWebhook, verifySignature, type Incoming, type Sender } from './whatsapp.js';
import { TelegramBot } from './telegram.js';
import { createAdminRouter } from './admin.js';

const env = process.env;
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
// On a hosting platform the app is on the public internet: no dev simulator, and client addresses come from its proxy.
const production = env.NODE_ENV === 'production' || Boolean(env.RAILWAY_ENVIRONMENT);

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
  // Where the admin's "Open dashboard" button points. Railway fills RAILWAY_PUBLIC_DOMAIN in once a domain exists.
  publicUrl: env.PUBLIC_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined),
};

const cloud = Boolean(env.WA_PHONE_NUMBER_ID && env.WA_TOKEN);
const dbPath = env.DB_PATH ?? './data.sqlite';
const db = openDb(dbPath);
// The dashboard can erase test data only while ALLOW_DATA_RESET=true. Turn it off before real users arrive.
const allowReset = env.ALLOW_DATA_RESET === 'true';
// Telegram is a stand-in for WhatsApp while Meta approval is pending; WhatsApp wins if both are configured.
const telegram = !cloud && env.TELEGRAM_BOT_TOKEN ? new TelegramBot(env.TELEGRAM_BOT_TOKEN, db) : undefined;
const memory = new MemorySender(true);
const sender: Sender = cloud ? new CloudSender(env.WA_PHONE_NUMBER_ID!, env.WA_TOKEN!) : telegram ?? memory;
const simulator = !cloud && !telegram && !production;
const channel = cloud ? 'Cloud API' : telegram ? 'TELEGRAM' : simulator ? 'DEV SIMULATOR (no WA_* env set)' : 'NONE';
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
if (production) app.set('trust proxy', 1); // one proxy hop (the platform's), so req.ip is the real client for the admin lockout
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

app.get('/health', (_req, res) => res.json({ ok: true, whatsapp: cloud ? 'cloud' : telegram ? 'telegram' : simulator ? 'dev-simulator' : 'none' }));

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
app.use('/admin', createAdminRouter({
  db, engine, sender, token: env.ADMIN_TOKEN, allowReset, adminPhone: env.ADMIN_PHONE,
  backupDir: dbPath === ':memory:' ? undefined : join(dirname(dbPath), 'backups'), // next to the database, so on the volume
  // The dashboard opened from the bot's /admin button signs in as the Telegram account linked to ADMIN_PHONE.
  telegramAuth: telegram && env.TELEGRAM_BOT_TOKEN && env.ADMIN_PHONE
    ? { botToken: env.TELEGRAM_BOT_TOKEN, isAdmin: (id) => telegram.isLinked(env.ADMIN_PHONE!.replace(/\D/g, ''), id) }
    : undefined,
}));
// The page itself holds no data: it asks for ADMIN_TOKEN, then calls /admin/*.
app.get('/dashboard', (_req, res) => {
  res.set('Cache-Control', 'no-store').sendFile(fileURLToPath(new URL('../public/admin.html', import.meta.url)));
});

// ---------- Dev simulator (only when neither WhatsApp nor Telegram is configured, and never on a host) ----------
if (simulator) {
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
const server = app.listen(port, () => {
  console.log(`[goverdhan-sawari] listening on :${port} — channel: ${channel}`);
  console.log(`[goverdhan-sawari] admin dashboard: ${production ? '<your public URL>' : `http://localhost:${port}`}/dashboard`);
  if (simulator) console.log(`[goverdhan-sawari] chat simulator UI: http://localhost:${port}/sim`);
  if (!env.ADMIN_TOKEN) console.warn('[warn] ADMIN_TOKEN not set — admin API disabled');
  if (allowReset) console.warn('[warn] ALLOW_DATA_RESET is on: the admin can erase all data from the dashboard. Turn it off before real drivers and riders use this.');
  if (!cfg.publicUrl && env.ADMIN_PHONE) console.warn('[warn] PUBLIC_URL not set — the admin /admin command cannot offer the dashboard button');
  if (cloud && !env.WA_APP_SECRET) console.warn('[warn] WA_APP_SECRET not set — webhook signatures are NOT verified');
  if (production) {
    if (channel === 'NONE') console.warn('[warn] no channel configured — set TELEGRAM_BOT_TOKEN, or WA_PHONE_NUMBER_ID and WA_TOKEN');
    if (!env.DB_PATH) console.warn('[warn] DB_PATH not set — the database is lost on every redeploy. Attach a volume and set DB_PATH=/data/data.sqlite');
    if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length < 16) console.warn('[warn] ADMIN_TOKEN is short — this API is on the public internet; use 24+ random characters');
  }
});
setInterval(() => { engine.tick().catch((e) => console.error('[tick]', e)); }, 5000);

// A redeploy sends SIGTERM: stop taking requests and close the database so its write-ahead log is flushed.
const shutdown = () => {
  console.log('[goverdhan-sawari] shutting down');
  server.close();
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
