// End-to-end simulation: no WhatsApp credentials needed. Run with `npm run sim`.
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { Engine, defaultConfig } from './flow.js';
import { MemorySender, type Incoming, type Out } from './whatsapp.js';

let clock = 1_700_000_000_000;
const db = openDb(':memory:');
const wa = new MemorySender();
const ADMIN = '919000000000';
const engine = new Engine(db, wa, { ...defaultConfig, adminPhone: ADMIN }, () => clock);

const D1 = '919111111111', D2 = '919222222222';
const R1 = '919333333333', R2 = '919444444444', R3 = '919555555555';

let n = 0;
const go = (from: string, p: Partial<Incoming>) => engine.handle({ id: `m${++n}`, from, kind: 'text', ...p } as Incoming);
const say = (from: string, text: string) => go(from, { kind: 'text', text });
const pick = (from: string, replyId: string) => go(from, { kind: 'reply', replyId });
const loc = (from: string, lat: number, lng: number) => go(from, { kind: 'location', lat, lng });
const img = (from: string, mediaId: string) => go(from, { kind: 'image', mediaId });
const advance = async (sec: number) => { clock += sec * 1000; await engine.tick(); };
const last = (phone: string): Out => wa.last(phone)!;
const texts = (phone: string) => wa.to(phone).filter((o) => o.t === 'text').map((o: any) => o.body as string);
const q = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;
const lastRideId = () => q<{ id: number }>('SELECT MAX(id) id FROM rides').id;
const step = (s: string) => console.log(`✓ ${s}`);

async function onboardDriver(phone: string, name: string, plate: string, lat: number, lng: number) {
  await say(phone, 'driver');
  await pick(phone, 'lang:hi');
  await say(phone, name);
  await say(phone, plate);
  await pick(phone, 'seats:4');
  await img(phone, `media-photo-${name.length}x`);
  await img(phone, `media-rc-${name.length}x`);
  assert.equal(q<{ status: string }>('SELECT status FROM drivers WHERE phone=?', phone).status, 'pending');
  assert.ok(texts(ADMIN).some((b) => b.includes(name)), 'admin notified of new driver');
  await engine.approveDriver(phone);
  await pick(phone, 'duty:on');
  assert.equal(last(phone).t, 'reqloc');
  await loc(phone, lat, lng);
  assert.equal(q<{ on_duty: number }>('SELECT on_duty FROM drivers WHERE phone=?', phone).on_duty, 1);
}

async function riderRequest(phone: string, lang: 'hi' | 'en', dropKey: string, group: number, lat: number, lng: number) {
  await say(phone, 'hi');
  if (q<{ lang: string | null }>('SELECT lang FROM users WHERE phone=?', phone).lang == null) await pick(phone, `lang:${lang}`);
  await loc(phone, lat, lng);
  await pick(phone, `drop:${dropKey}`);
  await pick(phone, `grp:${group}`);
  await pick(phone, 'when:now');
  return lastRideId();
}

// ---------------------------------------------------------------- A. onboarding
await onboardDriver(D1, 'Ramesh Kumar', 'up85 ab 1234', 27.498, 77.462);
await onboardDriver(D2, 'Suresh Yadav', 'up85 cd 5678', 27.499, 77.463);
step('two drivers onboarded via chat, approved, on duty');

// ---------------------------------------------------------------- B. quote ride, full lifecycle
const ride1 = await riderRequest(R1, 'en', 'mathura', 3, 27.497, 77.461);
assert.equal(q<{ kind: string }>('SELECT kind FROM rides WHERE id=?', ride1).kind, 'quote');
assert.equal(wa.to(D1).filter((o) => o.t === 'list').length, 1, 'D1 got quote request');
assert.equal(wa.to(D2).filter((o) => o.t === 'list').length, 1, 'D2 got quote request');
step('rider request fanned out to nearby drivers');

await pick(D1, `qp:${ride1}:300`);
await pick(D1, `qe:${ride1}:300:5`);
await pick(D2, `qo:${ride1}`);
await say(D2, 'abc');
assert.ok(texts(D2).some((b) => b.includes('350')), 'bad amount re-prompt');
await say(D2, '350');
await pick(D2, `qe:${ride1}:350:10`);
step('drivers quoted via list pick and typed amount');

await advance(181);
const shown = last(R1) as Extract<Out, { t: 'list' }>;
assert.equal(shown.t, 'list');
assert.equal(shown.rows.length, 2);
assert.ok(shown.rows[0].title.includes('₹300'), 'cheapest first');
const blob = JSON.stringify(wa.to(R1));
assert.ok(!blob.includes(D1.slice(2)) && !blob.includes(D2.slice(2)), 'driver numbers hidden before accept');
step('quote window closed → rider sees quotes, numbers still hidden');

await pick(R1, shown.rows[0].id);
assert.ok(texts(R1).some((b) => b.includes('+' + D1)), 'rider sees driver number after pick');
assert.ok(texts(D1).some((b) => b.includes('+' + R1)), 'driver sees rider number after pick');
assert.ok(wa.to(D1).some((o) => o.t === 'location'), 'driver gets pickup pin');
assert.ok(texts(D2).some((b) => b.includes('दूसरे ड्राइवर')), 'losing driver told ride taken');
step('contact details revealed only after rider picked; loser notified');

await pick(D1, `arr:${ride1}`);
const otp = q<{ otp: string }>('SELECT otp FROM rides WHERE id=?', ride1).otp;
assert.ok(texts(R1).some((b) => b.includes(otp)), 'rider gets start code');
await pick(D1, `go:${ride1}`);
await say(D1, '0000');
assert.equal(q<{ status: string }>('SELECT status FROM rides WHERE id=?', ride1).status, 'arrived', 'wrong code rejected');
await say(D1, otp);
assert.equal(q<{ status: string }>('SELECT status FROM rides WHERE id=?', ride1).status, 'started');
await pick(D1, `done:${ride1}`);
await pick(D1, `same:${ride1}`);
await pick(D1, `pay:${ride1}:cash:300`);
const done = q<any>('SELECT * FROM rides WHERE id=?', ride1);
assert.equal(done.status, 'completed');
assert.equal(done.final_fare, 300);
assert.equal(done.pay_mode, 'Cash');
assert.equal(q<{ rides_done: number }>('SELECT rides_done FROM drivers WHERE phone=?', D1).rides_done, 1);
await pick(R1, `rc:${ride1}:yes`);
assert.equal(q<{ rider_confirmed: string }>('SELECT rider_confirmed FROM rides WHERE id=?', ride1).rider_confirmed, 'yes');
step('arrive → OTP start → complete → fare + mode → rider confirms');

await advance(301);
assert.equal(last(R1).t, 'list', 'rider rating prompt sent after delay');
assert.equal(last(D1).t, 'buttons', 'driver thumbs prompt sent after delay');
await pick(R1, `rate:${ride1}:5`);
await pick(R1, `rate:${ride1}:1`); // duplicate tap must be ignored
await pick(R1, `tag:${ride1}:polite`);
await say(R1, 'Very polite and on time');
await pick(D1, `drate:${ride1}:up`);
const rating = q<any>("SELECT * FROM ratings WHERE ride_id=? AND from_role='rider'", ride1);
assert.equal(rating.rating, 5);
assert.equal(rating.tag, 'polite');
assert.equal(rating.note, 'Very polite and on time');
const d1 = q<any>('SELECT * FROM drivers WHERE phone=?', D1);
assert.equal(d1.rating_count, 1);
assert.equal(d1.rating_sum, 5);
step('feedback: stars, tag, note, driver thumbs; duplicate taps ignored');

// ---------------------------------------------------------------- C. fixed parikrama ride, race + cancel
const ride2 = await riderRequest(R2, 'hi', 'parikrama', 2, 27.497, 77.461);
const r2 = q<any>('SELECT * FROM rides WHERE id=?', ride2);
assert.equal(r2.kind, 'fixed');
assert.equal(r2.fixed_fare, defaultConfig.parikramaFarePerSeat * 2);
assert.equal((last(D1) as any).t, 'buttons');
await pick(D2, `acc:${ride2}`);
await pick(D1, `acc:${ride2}`); // too slow
assert.equal(q<{ driver_phone: string }>('SELECT driver_phone FROM rides WHERE id=?', ride2).driver_phone, D2, 'first accept wins');
assert.ok(texts(D1).slice(-2).some((b) => b.includes('दूसरे ड्राइवर') || b.includes('खुली नहीं')), 'slow driver told');
await say(R2, 'cancel');
const c2 = q<any>('SELECT * FROM rides WHERE id=?', ride2);
assert.equal(c2.status, 'cancelled');
assert.equal(c2.cancelled_by, 'rider');
assert.ok(texts(D2).some((b) => b.includes('यात्री ने')), 'driver told rider cancelled');
step('fixed-fare parikrama: first-accept-wins race, rider cancel notifies driver');

// ---------------------------------------------------------------- D. no drivers → widen → no_quotes
await pick(D1, 'duty:off');
await pick(D2, 'duty:off');
const ride3 = await riderRequest(R3, 'hi', 'vrindavan', 2, 27.497, 77.461);
await advance(181);
assert.equal(q<{ widened: number }>('SELECT widened FROM rides WHERE id=?', ride3).widened, 1, 'radius widened once');
await advance(181);
assert.equal(q<{ status: string }>('SELECT status FROM rides WHERE id=?', ride3).status, 'no_quotes');
step('no drivers: widened once, then rider told honestly');

// ---------------------------------------------------------------- E. webhook retry dedupe
const dup: Incoming = { id: 'dup-1', from: R3, kind: 'text', text: 'hi' };
await engine.handle(dup);
const before = wa.outbox.length;
await engine.handle(dup);
assert.equal(wa.outbox.length, before, 'duplicate webhook delivery ignored');
step('duplicate webhook deliveries are ignored');

// ---------------------------------------------------------------- summary
const rides = q<{ c: number }>('SELECT COUNT(*) c FROM rides').c;
const ev = q<{ c: number }>('SELECT COUNT(*) c FROM events').c;
console.log(`\nALL E2E CHECKS PASSED — ${rides} rides, ${ev} logged events, ${wa.outbox.length} outbound messages`);
