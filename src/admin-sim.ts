// Admin API test: in-memory DB, the real Engine, and a throwaway HTTP server. Run with `npm run sim:admin`.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createAdminRouter, ist } from './admin.js';
import { openDb } from './db.js';
import { Engine, defaultConfig } from './flow.js';
import { verifyInitData } from './tgauth.js';
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
  await say(phone, `${name}, ${plate}, 4`); // the whole form in one message
  await img(phone, 'FILE-photo');
  await img(phone, rcMediaId);
}

// ---------- seed: two submitted drivers, one unfinished, one full ride with feedback ----------
await signUp(D1, 'Ramesh Kumar', 'up85 ab 1234', 'FILE-rc'); // RC id the sender cannot download
await signUp(D2, 'Suresh Yadav', 'up85 cd 5678', 'FILE-html'); // a "file" that is not an image
await say(D3, 'driver');
await pick(D3, 'lang:hi');
await say(D3, 'Gopal');                                         // only a name: the vehicle number and seats are still missing

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

// ---------- Telegram mini-app sign-in ----------
// A test copy of how Telegram signs launch data: HMAC-SHA256 over the sorted fields, keyed by HMAC("WebAppData", bot token).
const BOT = '123456:TEST-BOT-TOKEN';
const ADMIN_TG_ID = 42;
const sign = (fields: Record<string, string>, botToken = BOT) => {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const hash = createHmac('sha256', createHmac('sha256', 'WebAppData').update(botToken).digest()).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash });
};
const fields = (userId: number, ageSec = 0): Record<string, string> =>
  ({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), query_id: 'AAH-test', user: JSON.stringify({ id: userId, first_name: 'Admin' }) });
const launch = (userId = ADMIN_TG_ID, ageSec = 0, botToken = BOT) => sign(fields(userId, ageSec), botToken).toString();

const tg = express();
tg.use('/admin', createAdminRouter({ db, engine, sender: wa, token: 'tok', telegramAuth: { botToken: BOT, isAdmin: (id) => id === ADMIN_TG_ID }, maxFailures: 100 }));
const s4 = tg.listen(0);
const asTg = (header: string) => fetch(`http://127.0.0.1:${(s4.address() as AddressInfo).port}/admin/stats`, { headers: { authorization: header } });

assert.equal((await asTg(`tma ${launch()}`)).status, 200, 'the admin\'s own Telegram launch data is accepted');
assert.equal((await asTg('Bearer tok')).status, 200, 'the token still works alongside');
assert.equal((await asTg(`tma ${launch(43)}`)).status, 401, 'a validly signed launch from a different Telegram account is refused');
assert.equal((await asTg(`tma ${launch(ADMIN_TG_ID, 0, '999999:OTHER-BOT')}`)).status, 401, 'signed with another bot\'s key');
const tampered = sign(fields(ADMIN_TG_ID)); // signed for the admin, then the user is swapped for someone else
tampered.set('user', JSON.stringify({ id: 43, first_name: 'Intruder' }));
assert.equal((await asTg(`tma ${tampered}`)).status, 401, 'a field changed after signing');
const swapped = sign(fields(43)); // signed for someone else, then relabelled as the admin
swapped.set('user', JSON.stringify({ id: ADMIN_TG_ID, first_name: 'Admin' }));
assert.equal((await asTg(`tma ${swapped}`)).status, 401, 'claiming to be the admin on someone else\'s signature');
assert.equal((await asTg(`tma ${launch(ADMIN_TG_ID, 2 * 24 * 3600)}`)).status, 401, 'launch data older than a day');
assert.equal((await asTg(`tma ${launch(ADMIN_TG_ID, -3600)}`)).status, 401, 'launch data dated in the future');
const noHash = new URLSearchParams(fields(ADMIN_TG_ID));
assert.equal((await asTg(`tma ${noHash}`)).status, 401, 'no signature at all');
const upper = sign(fields(ADMIN_TG_ID)); upper.set('hash', upper.get('hash')!.toUpperCase());
assert.equal((await asTg(`tma ${upper}`)).status, 401, 'malformed signature');
const noUser = sign({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH-test' });
assert.equal((await asTg(`tma ${noUser}`)).status, 401, 'validly signed but carrying no user');
assert.equal((await asTg('tma ')).status, 401, 'empty launch data');
assert.equal((await fetch(`${base}/admin/stats`, { headers: { authorization: `tma ${launch()}` } })).status, 401, 'a server without Telegram sign-in ignores launch data');
// direct checks of the verifier
assert.equal(verifyInitData(launch(), BOT)?.id, ADMIN_TG_ID);
assert.equal(verifyInitData(launch(ADMIN_TG_ID, 100), BOT, { maxAgeSec: 60 }), null, 'maxAgeSec is honoured');
assert.equal(verifyInitData(launch(ADMIN_TG_ID, 100), BOT, { maxAgeSec: 200 })?.id, ADMIN_TG_ID);
s4.close();
// bad launch data counts toward the lockout like a wrong token
const tgLock = express();
tgLock.use('/admin', createAdminRouter({ db, engine, sender: wa, token: 'tok', telegramAuth: { botToken: BOT, isAdmin: (id) => id === ADMIN_TG_ID }, maxFailures: 2 }));
const s5 = tgLock.listen(0);
const lockHit = (header: string) => fetch(`http://127.0.0.1:${(s5.address() as AddressInfo).port}/admin/stats`, { headers: { authorization: header } });
assert.equal((await lockHit(`tma ${launch(43)}`)).status, 401);
assert.equal((await lockHit(`tma ${launch(43)}`)).status, 401);
assert.equal((await lockHit(`tma ${launch()}`)).status, 429, 'repeated bad launch data locks the address out, even for the admin');
s5.close();
step('Telegram mini-app sign-in: the admin\'s account is accepted; other accounts, forged, tampered, expired and future-dated launch data are refused');

// ---------- drivers ----------
const all = await json('/admin/drivers?status=all');
assert.equal(all.length, 3);
assert.deepEqual(all.map((d: any) => d.status).sort(), ['draft', 'pending', 'pending']);
const draft = all.find((d: any) => d.phone === D3);
assert.equal(draft.name, 'Gopal');
assert.equal(draft.signup_step, 'drv_details', 'unfinished sign-up shows which step they are on');
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

// ---------- resetting test data ----------
const postJson = (url: string, body: unknown, token: string | null = 'tok') =>
  fetch(url, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const counts = () => Object.fromEntries(['users', 'drivers', 'rides', 'quotes', 'ratings', 'events'].map((t) => [t, (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c]));
assert.equal((await postJson(`${base}/admin/reset`, { scope: 'everything', confirm: 'DELETE' })).status, 403, 'reset is refused unless the server turns it on');
assert.deepEqual(await json('/admin/config'), { resetEnabled: false });
const seeded = counts();
assert.ok(seeded.rides > 0 && seeded.drivers > 0 && seeded.users > 0 && seeded.ratings > 0 && seeded.events > 0 && seeded.quotes > 0, 'there is data to erase');

const tmp = mkdtempSync(join(tmpdir(), 'sawari-reset-'));
const backupDir = join(tmp, 'backups');
db.exec('CREATE TABLE IF NOT EXISTS tg_links (phone TEXT PRIMARY KEY, chat_id INTEGER NOT NULL UNIQUE)');
db.prepare('INSERT INTO tg_links(phone, chat_id) VALUES (?, 1), (?, 2)').run(ADMIN, R1);
db.prepare("UPDATE users SET state='r_note', ctx='{\"rideId\":1}' WHERE phone=?").run(R1); // a rider part-way through feedback
const rr = express();
rr.use('/admin', createAdminRouter({ db, engine, sender: wa, token: 'tok', allowReset: true, backupDir, adminPhone: '+91 90000 00000' }));
const s6 = rr.listen(0);
const rbase = `http://127.0.0.1:${(s6.address() as AddressInfo).port}`;
const reset = (body: unknown, token: string | null = 'tok') => postJson(`${rbase}/admin/reset`, body, token);
assert.deepEqual(await (await fetch(`${rbase}/admin/config`, { headers: { authorization: 'Bearer tok' } })).json(), { resetEnabled: true });

// refusals leave everything as it was and write no backup
assert.equal((await reset({ scope: 'everything', confirm: 'DELETE' }, null)).status, 401, 'needs the admin token');
assert.equal((await reset({ scope: 'everything' })).status, 400, 'no confirmation');
assert.equal((await reset({ scope: 'everything', confirm: 'delete' })).status, 400, 'confirmation must be exactly DELETE');
assert.equal((await reset({ scope: 'users', confirm: 'DELETE' })).status, 400, 'unknown scope');
assert.equal((await postJson(`${rbase}/admin/reset`, 'not an object')).status, 400, 'garbage body');
assert.deepEqual(counts(), seeded, 'refused requests deleted nothing');
assert.deepEqual(readdirSync(tmp), [], 'and made no backup');

// scope "rides": rides and everything about them go; drivers and riders stay
const res1 = await reset({ scope: 'rides', confirm: 'DELETE' });
assert.equal(res1.status, 200);
const out1 = await res1.json() as any;
assert.equal(out1.deleted.rides, seeded.rides, 'reports what it deleted');
assert.deepEqual(counts(), { ...seeded, rides: 0, quotes: 0, ratings: 0, events: 0 });
const d1 = db.prepare('SELECT rides_done, rating_sum, rating_count FROM drivers WHERE phone=?').get(D1) as any;
assert.deepEqual(d1, { rides_done: 0, rating_sum: 0, rating_count: 0 }, 'driver counters reset');
assert.equal((db.prepare('SELECT state FROM users WHERE phone=?').get(R1) as any).state, 'idle', 'a rider mid-feedback goes back to idle');
assert.equal((db.prepare('SELECT state FROM users WHERE phone=?').get(D3) as any).state, 'drv_details', 'a sign-up in progress is kept');
assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='rides'").get(), undefined, 'ride numbers start at 1 again');
const backups1 = readdirSync(backupDir);
assert.equal(backups1.length, 1);
assert.ok(backups1[0].endsWith('-rides.sqlite') && out1.backup === backups1[0]);
const snap = openDb(join(backupDir, backups1[0]));
assert.equal((snap.prepare('SELECT COUNT(*) c FROM rides').get() as any).c, seeded.rides, 'the backup holds the data from before the reset');
assert.equal((snap.prepare('SELECT COUNT(*) c FROM drivers').get() as any).c, seeded.drivers);
snap.close();

// scope "everything": drivers and riders go too; only the admin's Telegram link survives
const res2 = await reset({ scope: 'everything', confirm: 'DELETE' });
assert.equal(res2.status, 200);
assert.deepEqual(counts(), { users: 0, drivers: 0, rides: 0, quotes: 0, ratings: 0, events: 0 });
assert.deepEqual(db.prepare('SELECT phone FROM tg_links').all(), [{ phone: ADMIN }], 'the admin stays linked, so the dashboard keeps working');
assert.equal((await (await fetch(`${rbase}/admin/stats`, { headers: { authorization: 'Bearer tok' } })).json() as any).rides.total, 0, 'the dashboard API reads an empty database');
// the app runs the flow again from a clean slate
await say(R1, 'hi', 'Rider One');
assert.equal(wa.last(R1).t, 'buttons', 'a reset rider starts over at the language question');
await say(D1, 'driver');
assert.equal(wa.last(D1).t, 'buttons', 'a reset driver starts sign-up again');

// only the newest 5 backups are kept
for (let i = 0; i < 6; i++) assert.equal((await reset({ scope: 'rides', confirm: 'DELETE' })).status, 200);
assert.equal(readdirSync(backupDir).length, 5, 'older backups are pruned');

// no backup, no deletion
writeFileSync(join(tmp, 'blocker'), 'a file where a folder is needed');
const bad = express();
bad.use('/admin', createAdminRouter({ db, engine, sender: wa, token: 'tok', allowReset: true, backupDir: join(tmp, 'blocker', 'sub') }));
const s7 = bad.listen(0);
db.prepare("INSERT INTO rides(rider_phone, status, t_requested) VALUES ('x', 'completed', 1)").run();
const failed = await postJson(`http://127.0.0.1:${(s7.address() as AddressInfo).port}/admin/reset`, { scope: 'everything', confirm: 'DELETE' });
assert.equal(failed.status, 500, 'a failed backup stops the reset');
assert.equal(counts().rides, 1, 'and nothing was deleted');
s6.close(); s7.close();
rmSync(tmp, { recursive: true, force: true });
step('reset: off unless enabled, exact DELETE confirmation, backup first (kept to 5), "rides" keeps people, "everything" keeps only the admin\'s link, no backup means no deletion');

// ---------- the page ----------
const page = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
assert.ok(page.includes('<title>Sawari Admin</title>'));
assert.ok(!/ADMIN_TOKEN\s*=|Bearer [A-Za-z0-9]{8,}/.test(page), 'the page carries no token');
step('dashboard page ships without any token baked in');

server.close();
console.log('\nADMIN API CHECKS PASSED');
