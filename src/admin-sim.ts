// Admin API test: in-memory DB, the real Engine, and a throwaway HTTP server. Run with `npm run sim:admin`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createAdminRouter, ist } from './admin.js';
import { openDb } from './db.js';
import { Engine, defaultConfig } from './flow.js';
import { MemorySender, type Incoming } from './whatsapp.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** MemorySender that can also "download" the two files this test uploads. */
class TestSender extends MemorySender {
  async media(id: string) {
    if (id === 'FILE-photo') return { contentType: 'image/png', data: PNG };
    if (id === 'FILE-html') return { contentType: 'text/html', data: Buffer.from('<script>alert(1)</script>') };
    return undefined;
  }
}

let clock = 1_700_000_000_000; // 2023-11-15 03:43:20 India time
const db = openDb(':memory:');
const wa = new TestSender();
const ADMIN = '919000000000';
const engine = new Engine(db, wa, { ...defaultConfig, adminPhone: ADMIN }, () => clock);
const D1 = '919111111111', D2 = '919222222222', D3 = '919333333333', R1 = '919444444444';

let n = 0;
const go = (from: string, p: Partial<Incoming>) => engine.handle({ id: `m${++n}`, from, kind: 'text', ...p } as Incoming);
const say = (from: string, text: string, name?: string) => go(from, { kind: 'text', text, name });
const pick = (from: string, replyId: string) => go(from, { kind: 'reply', replyId });
const loc = (from: string, lat: number, lng: number) => go(from, { kind: 'location', lat, lng });
const img = (from: string, mediaId: string) => go(from, { kind: 'image', mediaId });
const tick = async (sec: number) => { clock += sec * 1000; await engine.tick(); };
const step = (s: string) => console.log(`✓ ${s}`);

async function signUp(phone: string, name: string, plate: string, rcMediaId: string) {
  await say(phone, 'driver');
  await pick(phone, 'lang:hi');
  await say(phone, name);
  await say(phone, plate);
  await pick(phone, 'seats:4');
  await img(phone, 'FILE-photo');
  await img(phone, rcMediaId);
}

// ---------- seed: two submitted drivers, one unfinished, one full ride with feedback ----------
await signUp(D1, 'Ramesh Kumar', 'up85 ab 1234', 'FILE-rc'); // RC id the sender cannot download
await signUp(D2, 'Suresh Yadav', 'up85 cd 5678', 'FILE-html'); // a "file" that is not an image
await say(D3, 'driver');
await pick(D3, 'lang:hi');
await say(D3, 'Gopal');                                         // stops at the vehicle number

// ---------- the HTTP side ----------
const app = express();
app.use('/admin', createAdminRouter({ db, engine, sender: wa, token: 'tok' }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const get = (path: string, token: string | null = 'tok') => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (path: string) => fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer tok' } });
const json = async (path: string) => (await get(path)).json() as Promise<any>;

assert.equal((await get('/admin/stats', null)).status, 401, 'no token');
assert.equal((await get('/admin/stats', 'nope')).status, 401, 'wrong token');
assert.equal((await get('/admin/stats', 'tok1')).status, 401, 'token that is only a prefix match / different length');
const noToken = express();
noToken.use('/admin', createAdminRouter({ db, engine, sender: wa, token: undefined }));
const s2 = noToken.listen(0);
assert.equal((await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/admin/stats`, { headers: { authorization: 'Bearer undefined' } })).status, 401, 'no ADMIN_TOKEN configured → API closed');
s2.close();
step('every admin endpoint needs the exact token; with no ADMIN_TOKEN set it stays closed');

// Brute-force lockout: 3 wrong tokens in a row lock the address out, even for the right token; a right token resets the count.
const lock = express();
lock.use('/admin', createAdminRouter({ db, engine, sender: wa, token: 'tok', maxFailures: 3 }));
const s3 = lock.listen(0);
const hit = (token: string) => fetch(`http://127.0.0.1:${(s3.address() as AddressInfo).port}/admin/stats`, { headers: { authorization: `Bearer ${token}` } });
for (const t of ['x', 'y', 'tok', 'x', 'y', 'tok']) assert.equal((await hit(t)).status, t === 'tok' ? 200 : 401, `typos with a right token between them never lock out (${t})`);
for (const t of ['x', 'y', 'z']) assert.equal((await hit(t)).status, 401);
const locked = await hit('tok');
assert.equal(locked.status, 429, 'after 3 wrong tokens even the right one is refused');
assert.ok(Number(locked.headers.get('retry-after')) > 0, 'told how long to wait');
s3.close();
step('admin brute-force lockout: 3 wrong tokens lock an address out; a right token resets the count');

// ---------- drivers ----------
const all = await json('/admin/drivers?status=all');
assert.equal(all.length, 3);
assert.deepEqual(all.map((d: any) => d.status).sort(), ['draft', 'pending', 'pending']);
const draft = all.find((d: any) => d.phone === D3);
assert.equal(draft.name, 'Gopal');
assert.equal(draft.signup_step, 'drv_vehicle', 'unfinished sign-up shows which step they are on');
assert.equal((await json('/admin/drivers')).length, 2, 'default is still "pending" only');
assert.equal((await json('/admin/drivers?status=draft')).length, 1);
assert.equal((await (await post(`/admin/drivers/${D3}/approve`)).json() as any).ok, false, 'a draft cannot be approved');
assert.equal((await (await post(`/admin/drivers/${D1}/approve`)).json() as any).ok, true);
assert.equal((await (await post(`/admin/drivers/${D2}/reject`)).json() as any).ok, true);
assert.equal((await json('/admin/drivers?status=approved')).length, 1);
assert.equal((await json('/admin/drivers?status=rejected')).length, 1);
step('drivers: all / by status, unfinished sign-up step shown, approve and reject work, drafts refused');

// ---------- a full ride with feedback ----------
await pick(D1, 'duty:on');
await loc(D1, 27.498, 77.462);
await say(R1, 'hi', 'Rider One');
await pick(R1, 'lang:en');
await pick(R1, 'role:rider');
await loc(R1, 27.497, 77.461);
await pick(R1, 'drop:mansi');
await pick(R1, 'grp:3');
await pick(R1, 'when:now');
await pick(D1, 'qp:1:300');
await pick(D1, 'qe:1:300:5');
await tick(181);
await pick(R1, 'pick:1');
await pick(D1, 'arr:1');
const otp = (db.prepare('SELECT otp FROM rides WHERE id=1').get() as { otp: string }).otp;
await pick(D1, 'go:1');
await say(D1, otp);
await pick(D1, 'done:1');
await pick(D1, 'same:1');
await pick(D1, 'pay:1:cash:300');
await pick(R1, 'rc:1:yes');
await tick(301);
await pick(R1, 'rate:1:5');
await pick(R1, 'tag:1:polite');
await say(R1, 'Very polite and on time');
await pick(D1, 'drate:1:up');

// ---------- riders ----------
const riders = await json('/admin/riders');
assert.equal(riders.length, 1, 'drivers (even unfinished ones) are not listed as riders');
assert.deepEqual({ name: riders[0].name, phone: riders[0].phone, rides: riders[0].rides, completed: riders[0].completed, cancelled: riders[0].cancelled },
  { name: 'Rider One', phone: R1, rides: 1, completed: 1, cancelled: 0 });
assert.equal(riders[0].last_ride_at, 1_700_000_000_000);
step('riders: only non-drivers, with ride counts and last ride time');

// ---------- rides ----------
const rides = await json('/admin/rides');
assert.equal(rides.length, 1);
const r = rides[0];
assert.equal(r.status, 'completed');
assert.equal(r.rider_name, 'Rider One');
assert.equal(r.driver_name, 'Ramesh Kumar');
assert.equal(r.drop_text, 'Mansi Ganga');
assert.equal(r.final_fare, 300);
assert.equal(r.pay_mode, 'Cash');
assert.equal(r.rider_confirmed, 'yes');
assert.equal(r.rider_rating, 5);
assert.equal(r.rider_tag, 'polite');
assert.equal(r.rider_note, 'Very polite and on time');
assert.equal(r.driver_thumb, 1);
assert.equal(r.quotes_received, 1);
assert.ok(!('otp' in r), 'the start code is never exposed');
const detail = await json('/admin/rides/1');
const kinds = detail.events.map((e: any) => e.kind);
const order = ['requested', 'dispatch', 'quote', 'quotes_shown', 'matched', 'arrived', 'started', 'completed', 'rated'];
assert.deepEqual(order.map((k) => kinds.indexOf(k)).every((i: number, j: number, a: number[]) => i >= 0 && (j === 0 || i > a[j - 1])), true, `events in order, got ${kinds}`);
assert.equal(detail.events.find((e: any) => e.kind === 'matched').data.fare, 300);
assert.equal(detail.quotes.length, 1);
assert.equal(detail.quotes[0].driver_name, 'Ramesh Kumar');
assert.equal((await get('/admin/rides/999')).status, 404);
step('rides: names, fare, rating, tag, note and thumbs; timeline in order; start code hidden');

// ---------- photos and RCs ----------
const photo = await get(`/admin/media/photo/${D1}`);
assert.equal(photo.status, 200);
assert.equal(photo.headers.get('content-type'), 'image/png');
assert.equal(photo.headers.get('x-content-type-options'), 'nosniff');
assert.deepEqual(Buffer.from(await photo.arrayBuffer()), PNG, 'photo bytes come through unchanged');
assert.equal((await get(`/admin/media/rc/${D1}`)).status, 404, 'file the platform cannot return');
assert.equal((await get(`/admin/media/rc/${D2}`)).status, 415, 'non-image content is never served');
assert.equal((await get(`/admin/media/selfie/${D1}`)).status, 404, 'unknown kind');
assert.equal((await get(`/admin/media/photo/919000000999`)).status, 404, 'unknown driver');
assert.equal((await get(`/admin/media/photo/${D3}`)).status, 404, 'driver who has not sent one');
assert.equal((await get(`/admin/media/photo/${D1}`, null)).status, 401, 'images need the token too');
step('photo/RC: served only as images, only for a known driver, only with the token');

// ---------- stats and CSV ----------
const stats = await json('/admin/stats');
assert.equal(stats.drivers.approved, 1);
assert.equal(stats.drivers.pending, 0);
assert.equal(stats.rides.total, 1);
assert.equal(ist(1_700_000_000_000), '2023-11-15 03:43:20');
assert.equal(ist(null), '');
const csv = await (await get('/admin/rides.csv')).text();
const [head, row] = csv.split('\n');
for (const col of ['rider_name', 'driver_name', 'rider_note', 't_requested']) assert.ok(head.includes(col), `csv has ${col}`);
assert.ok(row.includes('"2023-11-15 03:43:20"'), 'CSV times are readable India time, not epoch milliseconds');
assert.ok(!/"\d{13}"/.test(row), 'no raw epoch milliseconds left');
assert.ok(row.includes('"Very polite and on time"') && row.includes('"Ramesh Kumar"'));
step('stats include pending drivers; CSV has names, notes and readable India-time stamps');

// ---------- the page ----------
const page = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
assert.ok(page.includes('<title>Sawari Admin</title>'));
assert.ok(!/ADMIN_TOKEN\s*=|Bearer [A-Za-z0-9]{8,}/.test(page), 'the page carries no token');
step('dashboard page ships without any token baked in');

server.close();
console.log('\nADMIN API CHECKS PASSED');
