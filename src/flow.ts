import { randomInt } from 'node:crypto';
import type { DB } from './db.js';
import { t, type Lang, type Key } from './messages.js';
import type { Sender, Incoming } from './whatsapp.js';

export type Config = {
  brand: string;
  parikramaFarePerSeat: number; // PLACEHOLDER — set to the real going rate
  quoteWindowSec: number;
  chooseWindowSec: number;
  nearbyKm: number;
  wideKm: number;
  feedbackDelaySec: number;
  locFreshHours: number;
  maxQuotes: number;
  adminPhone?: string;
};

export const defaultConfig: Config = {
  brand: 'Govardhan Sawari',
  parikramaFarePerSeat: 50,
  quoteWindowSec: 180,
  chooseWindowSec: 600,
  nearbyKm: 5,
  wideKm: 15,
  feedbackDelaySec: 300,
  locFreshHours: 12,
  maxQuotes: 5,
};

type User = { phone: string; lang: Lang | null; name: string | null; state: string; ctx: string };
type Driver = {
  phone: string; name: string; vehicle_no: string | null; seats: number;
  photo_media_id: string | null; rc_media_id: string | null; status: string; on_duty: number;
  lat: number | null; lng: number | null; loc_at: number | null;
  rating_sum: number; rating_count: number; rides_done: number;
};
type Ride = {
  id: number; rider_phone: string; rider_name: string | null;
  pickup_lat: number | null; pickup_lng: number | null; pickup_text: string | null;
  drop_key: string; drop_text: string; group_size: number; when_text: string;
  kind: 'fixed' | 'quote'; status: string; driver_phone: string | null;
  fixed_fare: number | null; agreed_fare: number | null; final_fare: number | null;
  otp: string | null; radius_km: number; widened: number; deadline: number | null;
};
type Quote = { id: number; ride_id: number; driver_phone: string; price: number | null; eta_min: number | null; status: string };

const DROP_EN: Record<string, string> = {
  parikrama: 'Govardhan Parikrama', mansi: 'Mansi Ganga', radha: 'Radha Kund',
  kusum: 'Kusum Sarovar', mathura: 'Mathura', vrindavan: 'Vrindavan',
};
const WHEN_EN: Record<string, string> = { now: 'Now', '1h': 'In 1 hour', tom: 'Tomorrow' };
const PRICE_OPTIONS = [100, 150, 200, 300, 400, 500, 700, 1000];
const TAGS = ['polite', 'ontime', 'fair', 'overcharged', 'unsafe', 'none'] as const;
const GREETING = /^(hi|hello|hey|hii|start|menu|namaste|नमस्ते|नमस्कार|हेलो)$/i;
const WANTS_RIDE = /^(ride|book|book a ride|taxi|sawari|सवारी)$/i;

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const plus = (p: string) => (p.startsWith('+') ? p : '+' + p);

/** Indian registration plate → tidy form ("up-85-ab 1234" → "UP85 AB 1234"), or null if it doesn't look like one. */
export function normalizePlate(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let m = s.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/); // UP85 AB 1234, UP85 1234
  if (m) return [m[1] + m[2], m[3], m[4]].filter(Boolean).join(' ');
  m = s.match(/^(\d{2})BH(\d{4})([A-Z]{1,2})$/); // Bharat series: 22 BH 1234 AA
  if (m) return `${m[1]} BH ${m[2]} ${m[3]}`;
  return null;
}

export class Engine {
  constructor(
    private db: DB,
    private send: Sender,
    private cfg: Config = defaultConfig,
    private clock: () => number = Date.now,
  ) {}

  // ================= small helpers =================
  private now() { return this.clock(); }
  private getUser(phone: string, name?: string): User {
    let u = this.db.prepare('SELECT * FROM users WHERE phone=?').get(phone) as User | undefined;
    if (!u) {
      this.db.prepare('INSERT INTO users(phone,name,created_at) VALUES (?,?,?)').run(phone, name ?? null, this.now());
      u = this.db.prepare('SELECT * FROM users WHERE phone=?').get(phone) as User;
    } else if (name && !u.name) {
      this.db.prepare('UPDATE users SET name=? WHERE phone=?').run(name, phone);
      u.name = name;
    }
    return u;
  }
  private ctx(u: User): Record<string, any> { try { return JSON.parse(u.ctx || '{}'); } catch { return {}; } }
  private setState(phone: string, state: string, patch?: Record<string, any>, reset = false) {
    const u = this.db.prepare('SELECT ctx FROM users WHERE phone=?').get(phone) as { ctx: string };
    const base = reset ? {} : JSON.parse(u?.ctx || '{}');
    this.db.prepare('UPDATE users SET state=?, ctx=? WHERE phone=?').run(state, JSON.stringify({ ...base, ...patch }), phone);
  }
  private lang(phone: string): Lang {
    const r = this.db.prepare('SELECT lang FROM users WHERE phone=?').get(phone) as { lang: Lang | null } | undefined;
    return r?.lang ?? 'hi';
  }
  private getDriver(phone: string) { return this.db.prepare('SELECT * FROM drivers WHERE phone=?').get(phone) as Driver | undefined; }
  private getRide(id: number) { return this.db.prepare('SELECT * FROM rides WHERE id=?').get(id) as Ride | undefined; }
  private log(rideId: number | null, kind: string, data: object = {}) {
    this.db.prepare('INSERT INTO events(ride_id,at,kind,data) VALUES (?,?,?,?)').run(rideId, this.now(), kind, JSON.stringify(data));
  }
  private tx(phone: string, key: Key, vars: Record<string, string | number> = {}) {
    return t(this.lang(phone), key, { brand: this.cfg.brand, ...vars });
  }
  private say(phone: string, key: Key, vars: Record<string, string | number> = {}) {
    return this.send.text(phone, this.tx(phone, key, vars));
  }
  private ratingLabel(d: Driver, lang: Lang) {
    return d.rating_count >= 3 ? `★${(d.rating_sum / d.rating_count).toFixed(1)}` : t(lang, 'new_label');
  }
  private activeRide(riderPhone: string) {
    return this.db.prepare("SELECT * FROM rides WHERE rider_phone=? AND status IN ('quoting','choosing','matched','arrived','started') ORDER BY id DESC LIMIT 1").get(riderPhone) as Ride | undefined;
  }
  private driverRide(driverPhone: string) {
    return this.db.prepare("SELECT * FROM rides WHERE driver_phone=? AND status IN ('matched','arrived','started') ORDER BY id DESC LIMIT 1").get(driverPhone) as Ride | undefined;
  }

  // ================= entry point =================
  async handle(m: Incoming): Promise<void> {
    const fresh = this.db.prepare('INSERT OR IGNORE INTO seen(id,at) VALUES (?,?)').run(m.id, this.now());
    if (fresh.changes === 0) return; // webhook retry
    const u = this.getUser(m.from, m.name);
    switch (m.kind) {
      case 'reply': return this.onReply(u, m);
      case 'location': return this.onLocation(u, m);
      case 'image': return this.onImage(u, m);
      case 'audio': return this.onAudio(u, m);
      case 'text': return this.onText(u, m);
      default: return this.say(u.phone, this.getDriver(u.phone) ? 'generic_help_driver' : 'generic_help');
    }
  }

  // ================= text =================
  private async onText(u: User, m: Incoming) {
    const txt = (m.text ?? '').trim();
    const drv = this.getDriver(u.phone);

    if (/^(cancel|रद्द|cancel ride)$/i.test(txt)) return this.onCancelText(u, drv);

    if (/^(driver|ड्राइवर|चालक)$/i.test(txt) && !(drv && drv.status !== 'draft')) return this.startDriver(u);
    if (u.state.startsWith('drv_')) return this.driverOnboarding(u, m, drv);
    if (drv && drv.status !== 'draft') return this.driverText(u, m, drv);
    return this.riderText(u, m);
  }

  // ================= RIDER =================
  private promptLang(phone: string) {
    return this.send.buttons(phone, t('hi', 'lang_prompt', { brand: this.cfg.brand }), [
      { id: 'lang:hi', title: 'हिंदी' }, { id: 'lang:en', title: 'English' },
    ]);
  }
  private async askRole(phone: string) {
    this.setState(phone, 'ask_role', {}, true);
    const l = this.lang(phone);
    await this.send.buttons(phone, t(l, 'ask_role'), [
      { id: 'role:rider', title: t(l, 'role_rider') }, { id: 'role:driver', title: t(l, 'role_driver') },
    ]);
  }
  private async askPickup(u: User) {
    this.setState(u.phone, 'ask_pickup', {}, true);
    await this.send.requestLocation(u.phone, this.tx(u.phone, 'ask_pickup'));
  }
  private async askDrop(phone: string) {
    this.setState(phone, 'ask_drop');
    const l = this.lang(phone);
    const rows = (['parikrama', 'mansi', 'radha', 'kusum', 'mathura', 'vrindavan', 'other'] as const).map((k) => ({
      id: `drop:${k}`, title: t(l, `drop_${k}` as Key),
      ...(k === 'parikrama' ? { description: t(l, 'drop_parikrama_d') } : {}),
    }));
    await this.send.list(phone, t(l, 'ask_drop'), t(l, 'drop_btn'), rows);
  }
  private async askGroup(phone: string) {
    this.setState(phone, 'ask_group');
    const l = this.lang(phone);
    const rows = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `grp:${n}`, title: n === 1 ? t(l, 'group_row_1') : t(l, 'group_row', { n }) }));
    await this.send.list(phone, t(l, 'ask_group'), t(l, 'group_btn'), rows);
  }
  private async askWhen(phone: string) {
    this.setState(phone, 'ask_when');
    const l = this.lang(phone);
    await this.send.buttons(phone, t(l, 'ask_when'), [
      { id: 'when:now', title: t(l, 'when_now') }, { id: 'when:1h', title: t(l, 'when_1h') }, { id: 'when:tom', title: t(l, 'when_tom') },
    ]);
  }

  private async riderText(u: User, m: Incoming) {
    const txt = (m.text ?? '').trim();
    if (!u.lang) return this.promptLang(u.phone);
    const active = this.activeRide(u.phone);

    if (u.state === 'r_note') return this.saveNote(u, txt, undefined);
    if (active) return this.say(u.phone, 'rider_busy');
    if (u.state === 'ask_role') return this.askRole(u.phone);
    if (GREETING.test(txt) || u.state === 'idle' || u.state === 'new') return this.askPickup(u);

    switch (u.state) {
      case 'ask_pickup':
        this.setState(u.phone, 'ask_pickup', { pickup_text: txt });
        return this.askDrop(u.phone);
      case 'ask_drop_other':
        this.setState(u.phone, 'ask_group', { drop_key: 'other', drop_text: txt });
        return this.askGroup(u.phone);
      case 'ask_drop': return this.askDrop(u.phone);
      case 'ask_group': return this.askGroup(u.phone);
      case 'ask_when': return this.askWhen(u.phone);
      default: return this.askPickup(u);
    }
  }

  private async createRide(u: User) {
    const c = this.ctx(u);
    const kind = c.drop_key === 'parikrama' ? 'fixed' : 'quote';
    const fare = kind === 'fixed' ? this.cfg.parikramaFarePerSeat * c.group : null;
    const now = this.now();
    const res = this.db.prepare(`INSERT INTO rides
      (rider_phone,rider_name,pickup_lat,pickup_lng,pickup_text,drop_key,drop_text,group_size,when_text,kind,status,fixed_fare,radius_km,deadline,t_requested)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'quoting', ?,?,?,?)`).run(
      u.phone, u.name, c.pickup_lat ?? null, c.pickup_lng ?? null, c.pickup_text ?? null,
      c.drop_key, c.drop_text, c.group, c.when_text, kind, fare, this.cfg.nearbyKm,
      now + this.cfg.quoteWindowSec * 1000, now);
    const id = Number(res.lastInsertRowid);
    this.log(id, 'requested', { kind, drop: c.drop_key, group: c.group });
    this.setState(u.phone, 'idle', {}, true);
    if (kind === 'fixed') await this.say(u.phone, 'searching_fixed', { group: c.group, fare: fare ?? '' });
    else await this.say(u.phone, 'searching_quote', { mins: Math.max(1, Math.round(this.cfg.quoteWindowSec / 60)) });
    await this.dispatch(this.getRide(id)!);
  }

  // ================= DISPATCH + QUOTES =================
  private nearbyDrivers(r: Ride, radius: number): Array<{ d: Driver; km: number | null }> {
    const cutoff = this.now() - this.cfg.locFreshHours * 3600_000;
    const pinged = new Set((this.db.prepare('SELECT driver_phone FROM quotes WHERE ride_id=?').all(r.id) as Quote[]).map((q) => q.driver_phone));
    const all = this.db.prepare("SELECT * FROM drivers WHERE status='approved' AND on_duty=1 AND loc_at>? AND seats>=?").all(cutoff, r.group_size) as Driver[];
    const out: Array<{ d: Driver; km: number | null }> = [];
    for (const d of all) {
      if (pinged.has(d.phone)) continue;
      let km: number | null = null;
      if (r.pickup_lat != null && r.pickup_lng != null && d.lat != null && d.lng != null) {
        km = haversineKm(r.pickup_lat, r.pickup_lng, d.lat, d.lng);
        if (km > radius) continue;
      }
      out.push({ d, km });
    }
    return out.sort((a, b) => (a.km ?? 99) - (b.km ?? 99));
  }

  private async dispatch(r: Ride) {
    const targets = this.nearbyDrivers(r, r.radius_km);
    this.log(r.id, 'dispatch', { radius: r.radius_km, drivers: targets.length });
    for (const { d, km } of targets) {
      this.db.prepare("INSERT INTO quotes(ride_id,driver_phone,status,created_at) VALUES (?,?, 'pinged', ?)").run(r.id, d.phone, this.now());
      const l = this.lang(d.phone);
      const vars = { dist: km == null ? '?' : km.toFixed(1), drop: r.drop_text, group: r.group_size, when: t(l, `when_${r.when_text}` as Key), fare: r.fixed_fare ?? '' } as Record<string, string | number>;
      try {
        if (r.kind === 'fixed') {
          await this.send.buttons(d.phone, t(l, 'offer_fixed', vars), [
            { id: `acc:${r.id}`, title: t(l, 'btn_accept') }, { id: `qs:${r.id}`, title: t(l, 'btn_skip') },
          ]);
        } else {
          const rows = [
            ...PRICE_OPTIONS.map((p) => ({ id: `qp:${r.id}:${p}`, title: `₹${p}` })),
            { id: `qo:${r.id}`, title: t(l, 'price_other') },
            { id: `qs:${r.id}`, title: t(l, 'price_skip') },
          ];
          await this.send.list(d.phone, t(l, 'offer_quote', vars), t(l, 'offer_quote_btn'), rows);
        }
      } catch (e) { console.error('[dispatch] send failed', d.phone, e); }
    }
  }

  private async driverQuoteStep(u: User, k: string, a: string[]) {
    const rideId = Number(a[0]);
    const r = this.getRide(rideId);
    const q = this.db.prepare('SELECT * FROM quotes WHERE ride_id=? AND driver_phone=?').get(rideId, u.phone) as Quote | undefined;
    const open = r && r.status === 'quoting' && r.kind === 'quote' && q && (q.status === 'pinged' || q.status === 'sent');
    if (k === 'qs') {
      if (q && q.status === 'pinged') this.db.prepare("UPDATE quotes SET status='skipped' WHERE id=?").run(q.id);
      return this.say(u.phone, 'driver_done');
    }
    if (!open) return this.say(u.phone, 'quote_late');
    const l = this.lang(u.phone);
    if (k === 'qp') {
      const price = Number(a[1]);
      return this.send.buttons(u.phone, t(l, 'ask_eta'), [5, 10, 15].map((e) => ({ id: `qe:${rideId}:${price}:${e}`, title: t(l, `eta_${e}` as Key) })));
    }
    if (k === 'qo') { this.setState(u.phone, 'dq_amount', { rideId }); return this.say(u.phone, 'ask_amount'); }
    if (k === 'qe') return this.submitQuote(u.phone, rideId, Number(a[1]), Number(a[2]));
  }

  private async submitQuote(driverPhone: string, rideId: number, price: number, eta: number) {
    const r = this.getRide(rideId);
    const q = this.db.prepare('SELECT * FROM quotes WHERE ride_id=? AND driver_phone=?').get(rideId, driverPhone) as Quote | undefined;
    if (!r || r.status !== 'quoting' || !q || (q.status !== 'pinged' && q.status !== 'sent')) return this.say(driverPhone, 'quote_late');
    this.db.prepare("UPDATE quotes SET price=?, eta_min=?, status='sent', quoted_at=? WHERE id=?").run(price, eta, this.now(), q.id);
    this.log(rideId, 'quote', { driver: driverPhone, price, eta });
    await this.say(driverPhone, 'quote_sent', { price });
    const n = (this.db.prepare("SELECT COUNT(*) c FROM quotes WHERE ride_id=? AND status='sent'").get(rideId) as { c: number }).c;
    if (n >= this.cfg.maxQuotes) await this.presentQuotes(rideId);
  }

  private referencePrice(r: Ride): number | null {
    const rows = this.db.prepare("SELECT final_fare f FROM rides WHERE status='completed' AND final_fare IS NOT NULL AND lower(drop_text)=lower(?) AND id<>? ORDER BY id DESC LIMIT 25").all(r.drop_text, r.id) as { f: number }[];
    return rows.length >= 3 ? median(rows.map((x) => x.f)) : null;
  }

  private async presentQuotes(rideId: number) {
    const r = this.getRide(rideId);
    if (!r || r.status !== 'quoting') return;
    const rows = this.db.prepare(`SELECT q.id qid, q.price, q.eta_min, d.* FROM quotes q JOIN drivers d ON d.phone=q.driver_phone
      WHERE q.ride_id=? AND q.status='sent' ORDER BY q.price ASC, (d.rating_sum*1.0/MAX(d.rating_count,1)) DESC LIMIT ?`).all(rideId, this.cfg.maxQuotes) as Array<Driver & { qid: number; price: number; eta_min: number }>;
    this.db.prepare("UPDATE rides SET status='choosing', deadline=? WHERE id=?").run(this.now() + this.cfg.chooseWindowSec * 1000, rideId);
    const l = this.lang(r.rider_phone);
    // Driver photos (best effort — never block the list)
    for (const x of rows) {
      if (!x.photo_media_id) continue;
      try { await this.send.image(r.rider_phone, x.photo_media_id, t(l, 'quote_photo_caption', { price: x.price, name: x.name.split(' ')[0], rating: this.ratingLabel(x, l), eta: x.eta_min })); } catch { /* ignore */ }
    }
    const ref = this.referencePrice(r);
    const listRows = rows.map((x) => ({
      id: `pick:${x.qid}`,
      title: t(l, 'quote_row', { price: x.price, name: x.name.split(' ')[0] }),
      description: t(l, 'quote_row_d', { rating: this.ratingLabel(x, l), eta: x.eta_min }),
    }));
    this.log(rideId, 'quotes_shown', { n: rows.length, ref });
    await this.send.list(r.rider_phone,
      t(l, 'quotes_body', { n: rows.length, ref: ref ? t(l, 'quotes_ref', { ref }) : '' }),
      t(l, 'quotes_btn'), listRows, t(l, 'quotes_header', { n: rows.length }));
  }

  private async riderPick(u: User, quoteId: number) {
    const q = this.db.prepare('SELECT * FROM quotes WHERE id=?').get(quoteId) as Quote | undefined;
    const r = q && this.getRide(q.ride_id);
    if (!q || !r || r.rider_phone !== u.phone || r.status !== 'choosing' || q.status !== 'sent') return this.say(u.phone, 'choose_expired');
    const res = this.db.prepare("UPDATE rides SET status='matched', driver_phone=?, agreed_fare=?, otp=?, t_accepted=? WHERE id=? AND status='choosing'")
      .run(q.driver_phone, q.price, String(randomInt(1000, 10000)), this.now(), r.id);
    if (res.changes === 0) return this.say(u.phone, 'choose_expired');
    await this.closeOthers(r.id, q.driver_phone);
    await this.reveal(r.id);
  }

  private async driverAcceptFixed(u: User, rideId: number) {
    const r = this.getRide(rideId);
    const q = this.db.prepare('SELECT * FROM quotes WHERE ride_id=? AND driver_phone=?').get(rideId, u.phone) as Quote | undefined;
    if (!r || r.kind !== 'fixed' || r.status !== 'quoting' || !q || q.status !== 'pinged') return this.say(u.phone, 'quote_late');
    const res = this.db.prepare("UPDATE rides SET status='matched', driver_phone=?, agreed_fare=fixed_fare, otp=?, t_accepted=? WHERE id=? AND status='quoting'")
      .run(u.phone, String(randomInt(1000, 10000)), this.now(), rideId);
    if (res.changes === 0) return this.say(u.phone, 'quote_late'); // someone was faster
    await this.closeOthers(rideId, u.phone);
    await this.reveal(rideId);
  }

  /** Mark winner, notify every other driver who was in play. */
  private async closeOthers(rideId: number, winner: string) {
    this.db.prepare("UPDATE quotes SET status='won' WHERE ride_id=? AND driver_phone=?").run(rideId, winner);
    const others = this.db.prepare("SELECT * FROM quotes WHERE ride_id=? AND driver_phone<>? AND status IN ('pinged','sent')").all(rideId, winner) as Quote[];
    for (const o of others) {
      this.db.prepare("UPDATE quotes SET status='lost' WHERE id=?").run(o.id);
      try { await this.say(o.driver_phone, 'ride_taken'); } catch { /* ignore */ }
    }
  }

  /** The moment contact details are exchanged. */
  private async reveal(rideId: number) {
    const r = this.getRide(rideId)!;
    const d = this.getDriver(r.driver_phone!)!;
    this.log(rideId, 'matched', { driver: d.phone, fare: r.agreed_fare });
    const dl = this.lang(d.phone);
    await this.say(r.rider_phone, 'matched_rider', { name: d.name, phone: plus(d.phone), vehicle: d.vehicle_no ?? this.tx(r.rider_phone, 'no_plate'), fare: r.agreed_fare ?? '' });
    await this.say(d.phone, 'you_won', {
      name: r.rider_name ?? 'Rider', phone: plus(r.rider_phone), group: r.group_size,
      when: t(dl, `when_${r.when_text}` as Key), drop: r.drop_text, fare: r.agreed_fare ?? '',
    });
    if (r.pickup_lat != null && r.pickup_lng != null) await this.send.location(d.phone, r.pickup_lat, r.pickup_lng, 'Pickup');
    else if (r.pickup_text) await this.send.text(d.phone, `📍 ${r.pickup_text}`);
    await this.send.buttons(d.phone, t(dl, 'on_way_driver'), [
      { id: `arr:${rideId}`, title: t(dl, 'btn_arrived') }, { id: `dc:${rideId}`, title: t(dl, 'btn_cancel') },
    ]);
  }

  // ================= TRIP (driver side buttons) =================
  private async tripStep(u: User, k: string, a: string[]) {
    const rideId = Number(a[0]);
    const r = this.getRide(rideId);
    if (!r || r.driver_phone !== u.phone) return this.say(u.phone, 'quote_late');
    const l = this.lang(u.phone);

    if (k === 'arr' && r.status === 'matched') {
      this.db.prepare("UPDATE rides SET status='arrived', t_arrived=? WHERE id=?").run(this.now(), rideId);
      this.log(rideId, 'arrived');
      await this.say(r.rider_phone, 'arrived_rider', { otp: r.otp! });
      return this.send.buttons(u.phone, t(l, 'arrived_driver'), [
        { id: `go:${rideId}`, title: t(l, 'btn_start') }, { id: `ns:${rideId}`, title: t(l, 'btn_noshow') },
      ]);
    }
    if (k === 'go' && r.status === 'arrived') {
      this.setState(u.phone, 'd_otp', { rideId });
      return this.say(u.phone, 'ask_otp');
    }
    if ((k === 'dc' && r.status === 'matched') || (k === 'ns' && (r.status === 'arrived' || r.status === 'matched'))) {
      const reason = k === 'ns' ? 'no_show' : 'driver_cancel';
      await this.cancelRide(r, 'driver', reason);
      await this.say(u.phone, 'driver_cancelled');
      return this.say(r.rider_phone, k === 'ns' ? 'rider_no_show' : 'rider_cancelled_by_driver');
    }
    if (k === 'done' && r.status === 'started') {
      return this.send.buttons(u.phone, t(l, 'ask_fare', { fare: r.agreed_fare ?? '' }), [
        { id: `same:${rideId}`, title: t(l, 'btn_same_fare', { fare: r.agreed_fare ?? '' }) },
        { id: `diff:${rideId}`, title: t(l, 'btn_diff_fare') },
      ]);
    }
    if (k === 'same' && r.status === 'started') return this.askPay(u.phone, rideId, r.agreed_fare ?? 0);
    if (k === 'diff' && r.status === 'started') { this.setState(u.phone, 'd_fare', { rideId }); return this.say(u.phone, 'ask_fare_amount'); }
    if (k === 'pay' && r.status === 'started') return this.complete(r, Number(a[2]), a[1] === 'upi' ? 'UPI' : 'Cash');
  }

  private askPay(phone: string, rideId: number, fare: number) {
    const l = this.lang(phone);
    return this.send.buttons(phone, t(l, 'ask_pay'), [
      { id: `pay:${rideId}:cash:${fare}`, title: t(l, 'btn_cash') }, { id: `pay:${rideId}:upi:${fare}`, title: t(l, 'btn_upi') },
    ]);
  }

  private async cancelRide(r: Ride, by: 'rider' | 'driver', reason: string) {
    this.db.prepare("UPDATE rides SET status='cancelled', cancelled_by=?, cancel_reason=?, t_cancelled=? WHERE id=?").run(by, reason, this.now(), r.id);
    this.log(r.id, 'cancelled', { by, reason });
  }

  private async complete(r: Ride, fare: number, mode: string) {
    const now = this.now();
    this.db.prepare("UPDATE rides SET status='completed', final_fare=?, pay_mode=?, t_completed=?, feedback_due=? WHERE id=? AND status='started'")
      .run(fare, mode, now, now + this.cfg.feedbackDelaySec * 1000, r.id);
    this.db.prepare('UPDATE drivers SET rides_done=rides_done+1 WHERE phone=?').run(r.driver_phone);
    this.log(r.id, 'completed', { fare, mode });
    await this.say(r.driver_phone!, 'completed_driver', { fare, mode });
    const l = this.lang(r.rider_phone);
    await this.send.buttons(r.rider_phone, t(l, 'confirm_ride', { fare, mode }), [
      { id: `rc:${r.id}:yes`, title: t(l, 'btn_yes') }, { id: `rc:${r.id}:no`, title: t(l, 'btn_no') },
    ]);
  }

  // ================= DRIVER text / onboarding =================
  private async startDriver(u: User, langKnown = false) {
    if (!this.getDriver(u.phone)) {
      this.db.prepare("INSERT INTO drivers(phone,status,created_at) VALUES (?, 'draft', ?)").run(u.phone, this.now());
    }
    if (langKnown) {
      this.setState(u.phone, 'drv_name', {}, true);
      return this.driverWelcome(u.phone);
    }
    this.setState(u.phone, 'drv_lang', {}, true);
    await this.promptLang(u.phone);
  }

  private async driverOnboarding(u: User, m: Incoming, drv?: Driver) {
    const txt = (m.text ?? '').trim();
    // "hi" mid-signup usually means they came in via the driver link but want a ride: ask, don't save it as a name.
    if (u.state !== 'drv_lang' && (GREETING.test(txt) || WANTS_RIDE.test(txt))) return this.askSwitch(u.phone);
    switch (u.state) {
      case 'drv_lang': return this.promptLang(u.phone);
      case 'drv_name':
        this.db.prepare('UPDATE drivers SET name=? WHERE phone=?').run(txt.slice(0, 60), u.phone);
        this.setState(u.phone, 'drv_vehicle');
        return this.say(u.phone, 'drv_ask_vehicle');
      case 'drv_vehicle': {
        const plate = normalizePlate(txt);
        if (!plate) {
          const l = this.lang(u.phone);
          return this.send.buttons(u.phone, t(l, 'drv_bad_vehicle'), [{ id: 'noplate', title: t(l, 'btn_no_plate') }]);
        }
        this.db.prepare('UPDATE drivers SET vehicle_no=? WHERE phone=?').run(plate, u.phone);
        return this.askSeats(u.phone);
      }
      case 'drv_seats': return this.askSeats(u.phone);
      case 'drv_photo': return this.say(u.phone, 'drv_need_photo');
      case 'drv_rc': return this.askRc(u.phone); // e.g. "nahi hai" — re-offer the skip button
    }
  }

  private driverWelcome(phone: string) {
    const l = this.lang(phone);
    return this.send.buttons(phone, t(l, 'drv_welcome'), [{ id: 'role:rider', title: t(l, 'role_rider') }]);
  }

  private askSwitch(phone: string) {
    const l = this.lang(phone);
    return this.send.buttons(phone, t(l, 'drv_switch'), [
      { id: 'role:rider', title: t(l, 'role_rider') }, { id: 'role:driver', title: t(l, 'btn_continue_driver') },
    ]);
  }

  /** Re-send the prompt for the signup step they are on. */
  private resumeOnboarding(phone: string, state: string) {
    switch (state) {
      case 'drv_name': return this.driverWelcome(phone);
      case 'drv_vehicle': return this.say(phone, 'drv_ask_vehicle');
      case 'drv_seats': return this.askSeats(phone);
      case 'drv_photo': return this.say(phone, 'drv_ask_photo');
      case 'drv_rc': return this.askRc(phone);
      default: return this.promptLang(phone);
    }
  }

  /** Abandon a half-finished driver signup; only a draft is removed, never a submitted or approved driver. */
  private dropDraftDriver(phone: string) {
    this.db.prepare("DELETE FROM drivers WHERE phone=? AND status='draft'").run(phone);
  }

  private askSeats(phone: string) {
    this.setState(phone, 'drv_seats');
    const l = this.lang(phone);
    return this.send.buttons(phone, t(l, 'drv_ask_seats'), [4, 5, 6].map((n) => ({ id: `seats:${n}`, title: String(n) })));
  }

  private askRc(phone: string) {
    const l = this.lang(phone);
    return this.send.buttons(phone, t(l, 'drv_ask_rc'), [{ id: 'rclater', title: t(l, 'btn_rc_later') }]);
  }

  /** End of onboarding; rcMediaId is null when the driver will send the RC later. */
  private async finishRegistration(u: User, rcMediaId: string | null) {
    this.db.prepare("UPDATE drivers SET rc_media_id=?, status='pending' WHERE phone=?").run(rcMediaId, u.phone);
    this.setState(u.phone, 'idle', {}, true);
    await this.say(u.phone, rcMediaId ? 'drv_pending' : 'drv_pending_no_rc');
    const d = this.getDriver(u.phone)!;
    if (this.cfg.adminPhone) {
      await this.send.buttons(
        this.cfg.adminPhone,
        `🆕 Driver pending approval: ${d.name} · ${d.vehicle_no ?? '⚠️ no number plate'} · ${d.seats} seats · ${plus(d.phone)}${rcMediaId ? '' : ' · ⚠️ RC not sent yet'}`,
        [{ id: `adm:ok:${d.phone}`, title: '✅ Approve' }, { id: `adm:no:${d.phone}`, title: '❌ Reject' }],
      );
    }
  }

  private async onImage(u: User, m: Incoming) {
    if (u.state === 'drv_photo') {
      this.db.prepare('UPDATE drivers SET photo_media_id=? WHERE phone=?').run(m.mediaId ?? null, u.phone);
      this.setState(u.phone, 'drv_rc');
      return this.askRc(u.phone);
    }
    if (u.state === 'drv_rc') return this.finishRegistration(u, m.mediaId ?? null);
    const drv = this.getDriver(u.phone);
    if (drv && drv.status !== 'draft' && !drv.rc_media_id && m.mediaId) {
      this.db.prepare('UPDATE drivers SET rc_media_id=? WHERE phone=?').run(m.mediaId, u.phone);
      await this.say(u.phone, 'drv_rc_received');
      if (this.cfg.adminPhone) await this.send.text(this.cfg.adminPhone, `📄 RC received from ${drv.name} · ${plus(drv.phone)}`);
      return;
    }
    return this.say(u.phone, drv ? 'generic_help_driver' : 'generic_help');
  }

  private async onAudio(u: User, m: Incoming) {
    if (u.state === 'r_note') return this.saveNote(u, undefined, m.mediaId);
    return this.say(u.phone, this.getDriver(u.phone) ? 'generic_help_driver' : 'generic_help');
  }

  private async driverMenu(phone: string) {
    const l = this.lang(phone);
    return this.send.buttons(phone, t(l, 'drv_menu'), [
      { id: 'duty:on', title: t(l, 'btn_duty_on') }, { id: 'duty:off', title: t(l, 'btn_duty_off') }, { id: 'menu:stats', title: t(l, 'btn_stats') },
    ]);
  }

  private async driverText(u: User, m: Incoming, drv: Driver) {
    const txt = (m.text ?? '').trim();
    if (drv.status === 'pending') return this.say(u.phone, 'drv_not_approved');
    if (drv.status === 'rejected') return this.say(u.phone, 'drv_rejected');
    const c = this.ctx(u);

    if (u.state === 'dq_amount') {
      const price = parseInt(txt.replace(/[^\d]/g, ''), 10);
      if (!price || price > 20000) return this.say(u.phone, 'bad_amount');
      this.setState(u.phone, 'idle', {}, true);
      const l = this.lang(u.phone);
      return this.send.buttons(u.phone, t(l, 'ask_eta'), [5, 10, 15].map((e) => ({ id: `qe:${c.rideId}:${price}:${e}`, title: t(l, `eta_${e}` as Key) })));
    }
    if (u.state === 'd_otp') {
      const r = this.getRide(c.rideId);
      if (!r || r.driver_phone !== u.phone || r.status !== 'arrived') { this.setState(u.phone, 'idle', {}, true); return this.driverMenu(u.phone); }
      if (txt.replace(/\D/g, '') !== r.otp) return this.say(u.phone, 'bad_otp');
      this.db.prepare("UPDATE rides SET status='started', t_started=? WHERE id=?").run(this.now(), r.id);
      this.setState(u.phone, 'idle', {}, true);
      this.log(r.id, 'started');
      await this.say(r.rider_phone, 'started_rider');
      const l = this.lang(u.phone);
      return this.send.buttons(u.phone, t(l, 'started_driver'), [{ id: `done:${r.id}`, title: t(l, 'btn_complete') }]);
    }
    if (u.state === 'd_fare') {
      const fare = parseInt(txt.replace(/[^\d]/g, ''), 10);
      if (!fare || fare > 50000) return this.say(u.phone, 'bad_amount');
      this.setState(u.phone, 'idle', {}, true);
      return this.askPay(u.phone, c.rideId, fare);
    }
    if (/^(duty|duty on|ड्यूटी)$/i.test(txt)) return this.dutyOn(u.phone);
    if (/^(duty off|ड्यूटी ऑफ)$/i.test(txt)) return this.dutyOff(u.phone);
    return this.driverMenu(u.phone);
  }

  private async dutyOn(phone: string) {
    this.setState(phone, 'd_loc');
    await this.send.requestLocation(phone, this.tx(phone, 'drv_ask_loc'));
  }
  private async dutyOff(phone: string) {
    this.db.prepare('UPDATE drivers SET on_duty=0 WHERE phone=?').run(phone);
    this.setState(phone, 'idle', {}, true);
    await this.say(phone, 'drv_off');
  }

  // ================= location =================
  private async onLocation(u: User, m: Incoming) {
    const drv = this.getDriver(u.phone);
    if (drv && drv.status === 'approved') {
      this.db.prepare('UPDATE drivers SET lat=?, lng=?, loc_at=? WHERE phone=?').run(m.lat, m.lng, this.now(), u.phone);
      if (u.state === 'd_loc') {
        this.db.prepare('UPDATE drivers SET on_duty=1 WHERE phone=?').run(u.phone);
        this.setState(u.phone, 'idle', {}, true);
        await this.say(u.phone, 'drv_on');
      }
      return;
    }
    if (drv && drv.status !== 'draft') return this.say(u.phone, 'drv_not_approved');
    if (!u.lang) return this.promptLang(u.phone);
    if (this.activeRide(u.phone)) return this.say(u.phone, 'rider_busy');
    this.setState(u.phone, 'ask_pickup', { pickup_lat: m.lat, pickup_lng: m.lng, pickup_text: m.text ?? null }, u.state !== 'ask_pickup');
    return this.askDrop(u.phone);
  }

  // ================= replies (buttons / lists) =================
  private async onReply(u: User, m: Incoming) {
    const [k, ...a] = (m.replyId ?? '').split(':');
    switch (k) {
      case 'lang': return this.onLang(u, a[0] === 'en' ? 'en' : 'hi');
      case 'role': {
        if (u.state === 'ask_role') return a[0] === 'driver' ? this.startDriver(u, true) : this.askPickup(u);
        if (u.state.startsWith('drv_')) {
          if (a[0] === 'driver') return this.resumeOnboarding(u.phone, u.state);
          this.dropDraftDriver(u.phone);
          return this.askPickup(u);
        }
        return;
      }
      case 'drop': {
        if (a[0] === 'other') { this.setState(u.phone, 'ask_drop_other'); return this.say(u.phone, 'ask_drop_other'); }
        this.setState(u.phone, 'ask_group', { drop_key: a[0], drop_text: DROP_EN[a[0]] ?? a[0] });
        return this.askGroup(u.phone);
      }
      case 'grp': this.setState(u.phone, 'ask_when', { group: Number(a[0]) }); return this.askWhen(u.phone);
      case 'when': {
        if (this.activeRide(u.phone)) return this.say(u.phone, 'rider_busy');
        this.setState(u.phone, 'creating', { when_text: a[0] in WHEN_EN ? a[0] : 'now' });
        return this.createRide(this.getUser(u.phone));
      }
      case 'pick': return this.riderPick(u, Number(a[0]));
      case 'rc': return this.onRiderConfirm(u, Number(a[0]), a[1]);
      case 'rate': return this.onRate(u, Number(a[0]), Number(a[1]));
      case 'tag': return this.onTag(u, Number(a[0]), a[1]);
      case 'drate': return this.onDriverRate(u, Number(a[0]), a[1]);
      case 'acc': return this.driverAcceptFixed(u, Number(a[0]));
      case 'qp': case 'qo': case 'qs': case 'qe': return this.driverQuoteStep(u, k, a);
      case 'arr': case 'go': case 'dc': case 'ns': case 'done': case 'same': case 'diff': case 'pay': return this.tripStep(u, k, a);
      case 'seats': {
        if (u.state !== 'drv_seats') return;
        this.db.prepare('UPDATE drivers SET seats=? WHERE phone=?').run(Number(a[0]), u.phone);
        this.setState(u.phone, 'drv_photo');
        return this.say(u.phone, 'drv_ask_photo');
      }
      case 'adm': {
        // Only the configured admin may approve or reject, whatever the button says.
        if (!this.cfg.adminPhone || u.phone !== this.cfg.adminPhone.replace(/\D/g, '')) return;
        const ok = a[0] === 'ok' ? await this.approveDriver(a[1]) : await this.rejectDriver(a[1]);
        const d = this.getDriver(a[1]);
        return this.send.text(u.phone, ok ? `${a[0] === 'ok' ? '✅ Approved' : '❌ Rejected'}: ${d?.name ?? plus(a[1])}` : `Nothing changed for ${plus(a[1])}.`);
      }
      case 'noplate': {
        if (u.state !== 'drv_vehicle') return;
        this.db.prepare('UPDATE drivers SET vehicle_no=NULL WHERE phone=?').run(u.phone);
        return this.askSeats(u.phone);
      }
      case 'rclater': {
        if (u.state !== 'drv_rc') return;
        return this.finishRegistration(u, null);
      }
      case 'duty': return a[0] === 'on' ? this.dutyOn(u.phone) : this.dutyOff(u.phone);
      case 'menu': {
        const d = this.getDriver(u.phone);
        if (!d) return;
        const rating = d.rating_count ? `★${(d.rating_sum / d.rating_count).toFixed(1)} (${d.rating_count})` : '—';
        return this.say(u.phone, 'drv_stats', { rides: d.rides_done, rating });
      }
    }
  }

  private async onLang(u: User, lang: Lang) {
    const firstContact = u.lang == null;
    this.db.prepare('UPDATE users SET lang=? WHERE phone=?').run(lang, u.phone);
    const drv = this.getDriver(u.phone);
    if (u.state === 'drv_lang') {
      this.setState(u.phone, 'drv_name');
      return this.driverWelcome(u.phone);
    }
    if (drv && drv.status === 'approved') return this.driverMenu(u.phone);
    // A driver who opens with "hi" instead of the DRIVER keyword must not be pushed into booking a ride.
    if (firstContact && !drv) return this.askRole(u.phone);
    return this.askPickup(this.getUser(u.phone));
  }

  // ================= feedback =================
  private async onRiderConfirm(u: User, rideId: number, ans: string) {
    const r = this.getRide(rideId);
    if (!r || r.rider_phone !== u.phone || r.status !== 'completed') return;
    this.db.prepare('UPDATE rides SET rider_confirmed=? WHERE id=?').run(ans === 'yes' ? 'yes' : 'no', rideId);
    this.log(rideId, ans === 'yes' ? 'rider_confirmed' : 'rider_disputed');
    return this.say(u.phone, ans === 'yes' ? 'thanks_confirm' : 'dispute_noted');
  }

  private async sendFeedbackPrompts(r: Ride) {
    const d = this.getDriver(r.driver_phone!)!;
    const rl = this.lang(r.rider_phone);
    const rows = [5, 4, 3, 2, 1].map((n) => ({ id: `rate:${r.id}:${n}`, title: t(rl, `rate_row_${n}` as Key) }));
    await this.send.list(r.rider_phone, t(rl, 'rate_prompt', { name: d.name.split(' ')[0] }), t(rl, 'rate_btn'), rows);
    const dl = this.lang(d.phone);
    await this.send.buttons(d.phone, t(dl, 'rate_rider_prompt'), [
      { id: `drate:${r.id}:up`, title: t(dl, 'btn_up') }, { id: `drate:${r.id}:down`, title: t(dl, 'btn_down') },
    ]);
  }

  private async onRate(u: User, rideId: number, n: number) {
    const r = this.getRide(rideId);
    if (!r || r.rider_phone !== u.phone || !r.driver_phone || n < 1 || n > 5) return;
    const exists = this.db.prepare("SELECT id FROM ratings WHERE ride_id=? AND from_role='rider'").get(rideId);
    if (exists) return;
    this.db.prepare("INSERT INTO ratings(ride_id,from_role,rating,created_at) VALUES (?, 'rider', ?, ?)").run(rideId, n, this.now());
    this.db.prepare('UPDATE drivers SET rating_sum=rating_sum+?, rating_count=rating_count+1 WHERE phone=?').run(n, r.driver_phone);
    this.log(rideId, 'rated', { n });
    const l = this.lang(u.phone);
    const rows = TAGS.map((tg) => ({ id: `tag:${rideId}:${tg}`, title: t(l, `tag_${tg}` as Key) }));
    await this.send.list(u.phone, t(l, 'tag_prompt'), t(l, 'tag_btn'), rows);
  }

  private async onTag(u: User, rideId: number, tag: string) {
    const r = this.getRide(rideId);
    if (!r || r.rider_phone !== u.phone) return;
    this.db.prepare("UPDATE ratings SET tag=? WHERE ride_id=? AND from_role='rider'").run(tag, rideId);
    this.setState(u.phone, 'r_note', { rideId });
    return this.say(u.phone, 'note_prompt');
  }

  private async saveNote(u: User, text?: string, mediaId?: string) {
    const c = this.ctx(u);
    const skip = text && /^(skip|छोड़ें|no|नहीं)$/i.test(text);
    if (!skip) {
      this.db.prepare("UPDATE ratings SET note=?, note_media_id=? WHERE ride_id=? AND from_role='rider'").run(text ?? null, mediaId ?? null, c.rideId);
    }
    this.setState(u.phone, 'idle', {}, true);
    return this.say(u.phone, 'rider_done');
  }

  private async onDriverRate(u: User, rideId: number, v: string) {
    const r = this.getRide(rideId);
    if (!r || r.driver_phone !== u.phone) return;
    const exists = this.db.prepare("SELECT id FROM ratings WHERE ride_id=? AND from_role='driver'").get(rideId);
    if (!exists) {
      this.db.prepare("INSERT INTO ratings(ride_id,from_role,rating,tag,created_at) VALUES (?, 'driver', ?, ?, ?)").run(rideId, v === 'up' ? 1 : 0, v === 'up' ? 'rider_good' : 'rider_problem', this.now());
    }
    return this.say(u.phone, 'driver_done');
  }

  // ================= cancel (text) =================
  private async onCancelText(u: User, drv?: Driver) {
    if (u.state.startsWith('drv_') && (!drv || drv.status === 'draft')) {
      this.dropDraftDriver(u.phone);
      this.setState(u.phone, 'idle', {}, true);
      return this.say(u.phone, 'drv_signup_cancelled');
    }
    if (drv && drv.status === 'approved') {
      const r = this.driverRide(u.phone);
      if (r && (r.status === 'matched' || r.status === 'arrived')) {
        await this.cancelRide(r, 'driver', 'driver_cancel');
        await this.say(u.phone, 'driver_cancelled');
        return this.say(r.rider_phone, 'rider_cancelled_by_driver');
      }
      this.setState(u.phone, 'idle', {}, true);
      return this.driverMenu(u.phone);
    }
    const r = this.activeRide(u.phone);
    if (!r) { this.setState(u.phone, 'idle', {}, true); return this.say(u.phone, 'rider_cancelled'); }
    if (r.status === 'started') return this.say(u.phone, 'rider_busy');
    await this.cancelRide(r, 'rider', 'rider_cancel');
    if (r.driver_phone) await this.say(r.driver_phone, 'driver_cancelled_by_rider');
    return this.say(u.phone, 'rider_cancelled');
  }

  // ================= scheduler =================
  /** Call every few seconds. Closes quote windows, expires stale choices, sends feedback prompts. */
  async tick(): Promise<void> {
    const now = this.now();
    const due = this.db.prepare("SELECT * FROM rides WHERE status IN ('quoting','choosing') AND deadline IS NOT NULL AND deadline<=?").all(now) as Ride[];
    for (const r of due) {
      try {
        if (r.status === 'choosing') {
          this.db.prepare("UPDATE rides SET status='expired' WHERE id=?").run(r.id);
          this.log(r.id, 'expired');
          await this.say(r.rider_phone, 'choose_expired');
          continue;
        }
        const sent = (this.db.prepare("SELECT COUNT(*) c FROM quotes WHERE ride_id=? AND status='sent'").get(r.id) as { c: number }).c;
        if (r.kind === 'quote' && sent > 0) { await this.presentQuotes(r.id); continue; }
        if (!r.widened) {
          this.db.prepare('UPDATE rides SET widened=1, radius_km=?, deadline=? WHERE id=?').run(this.cfg.wideKm, now + this.cfg.quoteWindowSec * 1000, r.id);
          await this.say(r.rider_phone, 'searching_wider');
          await this.dispatch(this.getRide(r.id)!);
          continue;
        }
        this.db.prepare("UPDATE rides SET status='no_quotes' WHERE id=?").run(r.id);
        this.log(r.id, 'no_quotes');
        await this.say(r.rider_phone, 'no_quotes');
      } catch (e) { console.error('[tick] ride', r.id, e); }
    }
    const fb = this.db.prepare("SELECT * FROM rides WHERE status='completed' AND feedback_sent=0 AND feedback_due<=?").all(now) as Ride[];
    for (const r of fb) {
      this.db.prepare('UPDATE rides SET feedback_sent=1 WHERE id=?').run(r.id);
      try { await this.sendFeedbackPrompts(r); } catch (e) { console.error('[tick] feedback', r.id, e); }
    }
  }

  // ================= admin =================
  async approveDriver(phone: string) {
    const d = this.getDriver(phone);
    if (!d || d.status === 'draft') return false;
    this.db.prepare("UPDATE drivers SET status='approved' WHERE phone=?").run(phone);
    await this.say(phone, 'drv_approved');
    await this.driverMenu(phone);
    return true;
  }
  async rejectDriver(phone: string) {
    const d = this.getDriver(phone);
    if (!d || d.status === 'draft') return false;
    this.db.prepare("UPDATE drivers SET status='rejected', on_duty=0 WHERE phone=?").run(phone);
    await this.say(phone, 'drv_rejected');
    return true;
  }
}
