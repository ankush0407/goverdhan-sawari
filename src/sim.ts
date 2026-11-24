// End-to-end simulation: no WhatsApp credentials needed. Run with `npm run sim`.
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { parseDriverDetails } from './driverform.js';
import { Engine, defaultConfig, normalizePlate } from './flow.js';
import { MemorySender, type Incoming, type Out } from './whatsapp.js';

let clock = 1_700_000_000_000;
const db = openDb(':memory:');
const wa = new MemorySender();
const ADMIN = '919000000000';
const engine = new Engine(db, wa, { ...defaultConfig, adminPhone: ADMIN, publicUrl: 'https://sawari.example' }, () => clock);

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
const bodies = (phone: string) => wa.to(phone).map((o: any) => (o.body ?? o.caption ?? '') as string);
const q = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;
const lastRideId = () => q<{ id: number }>('SELECT MAX(id) id FROM rides').id;
const step = (s: string) => console.log(`✓ ${s}`);

async function onboardDriver(phone: string, name: string, plate: string, lat: number, lng: number) {
  await say(phone, 'driver');
  await pick(phone, 'lang:hi');
  await say(phone, `${name}, ${plate}, 4`); // the whole form in one message
  assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', phone).state, 'drv_photo', 'one message was enough for the details');
  await img(phone, `media-photo-${name.length}x`);
  await img(phone, `media-rc-${name.length}x`);
  assert.equal(q<{ status: string }>('SELECT status FROM drivers WHERE phone=?', phone).status, 'pending');
  assert.ok(bodies(ADMIN).some((b) => b.includes(name)), 'admin notified of new driver');
  await engine.approveDriver(phone);
  await pick(phone, 'duty:on');
  assert.equal(last(phone).t, 'reqloc');
  await loc(phone, lat, lng);
  assert.equal(q<{ on_duty: number }>('SELECT on_duty FROM drivers WHERE phone=?', phone).on_duty, 1);
}

async function riderRequest(phone: string, lang: 'hi' | 'en', dropKey: string, group: number, lat: number, lng: number) {
  await say(phone, 'hi');
  if (q<{ lang: string | null }>('SELECT lang FROM users WHERE phone=?', phone).lang == null) {
    await pick(phone, `lang:${lang}`);
    await pick(phone, 'role:rider');
  }
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

const D3 = '919666666666';
await say(D3, 'hi');
await pick(D3, 'lang:en');
const role = last(D3) as Extract<Out, { t: 'buttons' }>;
assert.equal(role.t, 'buttons');
assert.deepEqual(role.buttons.map((b) => b.id), ['role:rider', 'role:driver'], 'new user asked rider or driver');
await pick(D3, 'role:driver');
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', D3).state, 'drv_details');
assert.equal(q<{ status: string }>('SELECT status FROM drivers WHERE phone=?', D3).status, 'draft');
const welcome = last(D3) as Extract<Out, { t: 'text' }>;
assert.equal(welcome.t, 'text', 'the driver welcome is plain text');
assert.ok(welcome.body.includes('ONE message') && welcome.body.includes('Ramesh Kumar, UP85 AB 1234, 4'), 'asks for everything in one message, with an example');
assert.ok(!JSON.stringify(welcome).includes('role:rider') && !JSON.stringify(welcome).includes('Book a ride'), 'no "Book a ride" button for a driver registering');
step('driver who opens with "hi" picks "I am a driver" and lands in onboarding');

await say(D3, 'Mohan Lal'); // only a name: ask for just the rest
const ask1 = last(D3) as Extract<Out, { t: 'buttons' }>;
assert.ok(ask1.body.includes('vehicle number') && ask1.body.includes('seats') && !ask1.body.includes('full name'), 'asks only for what is missing');
assert.ok(ask1.buttons.some((b) => b.id === 'noplate'), 'offers "no number plate" while the plate is missing');
await say(D3, 'nahi hai');
assert.equal(q<{ name: string }>('SELECT name FROM drivers WHERE phone=?', D3).name, 'Mohan Lal', 'a stray word does not replace the name');
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', D3).state, 'drv_details', 'still waiting for the vehicle number and seats');
await say(D3, 'up-85-ef 9012, 5'); // the two missing pieces, in one go
const d3form = q<any>('SELECT name, vehicle_no, seats FROM drivers WHERE phone=?', D3);
assert.deepEqual(d3form, { name: 'Mohan Lal', vehicle_no: 'UP85 EF 9012', seats: 5 });
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', D3).state, 'drv_photo', 'details complete → photo');
assert.ok(texts(D3).at(-1)!.includes('Got your details'));
await img(D3, 'media-photo-mohan');
await say(D3, "don't have");
assert.ok((last(D3) as any).buttons?.some((b: { id: string }) => b.id === 'rclater'), 'typing instead of a photo re-offers the skip button');
await pick(D3, 'rclater');
const d3 = q<any>('SELECT status, rc_media_id FROM drivers WHERE phone=?', D3);
assert.equal(d3.status, 'pending');
assert.equal(d3.rc_media_id, null);
assert.ok(bodies(ADMIN).some((b) => b.includes('Mohan Lal') && b.includes('RC not sent')), 'admin told RC is missing');
await img(D3, 'media-rc-mohan-later');
assert.equal(q<{ rc_media_id: string }>('SELECT rc_media_id FROM drivers WHERE phone=?', D3).rc_media_id, 'media-rc-mohan-later');
assert.ok(bodies(ADMIN).some((b) => b.includes('RC received from Mohan Lal')), 'admin told RC arrived');
step('driver without RC finishes sign-up, sends RC later, admin informed both times');

assert.ok(wa.to(ADMIN).some((o: any) => o.t === 'buttons' && o.buttons.some((b: { id: string }) => b.id === `adm:ok:${D3}`)), 'admin alert has Approve button');
await pick(R1, `adm:ok:${D3}`); // not the admin
assert.equal(q<{ status: string }>('SELECT status FROM drivers WHERE phone=?', D3).status, 'pending', 'non-admin cannot approve');
await pick(ADMIN, `adm:ok:${D3}`);
assert.equal(q<{ status: string }>('SELECT status FROM drivers WHERE phone=?', D3).status, 'approved');
assert.ok(texts(ADMIN).some((b) => b.includes('Approved: Mohan Lal')), 'admin told approval went through');
assert.equal(last(D3).t, 'buttons', 'driver gets approval + duty menu');
step('admin approves a driver with the button in their own chat; others cannot');

// The admin's "admin" / "/admin" command answers with a dashboard button; nobody else gets one.
await say(ADMIN, 'admin');
const dash = last(ADMIN) as Extract<Out, { t: 'link' }>;
assert.equal(dash.t, 'link', 'the admin gets a button that opens the dashboard');
assert.equal(dash.url, 'https://sawari.example/dashboard');
assert.equal(dash.label, 'Open dashboard');
const R9 = '919777000009';
await say(R9, 'admin');
await say(D3, 'Admin');
assert.ok(![...wa.to(R9), ...wa.to(D3)].some((o) => o.t === 'link' || JSON.stringify(o).includes('dashboard')), 'a rider or driver typing "admin" gets no dashboard');
// On a channel without link buttons (WhatsApp) the address goes out as text; a trailing slash is not doubled; no address → a hint.
class NoLink extends MemorySender {}
(NoLink.prototype as any).link = undefined;
const plain = new NoLink();
const plainEngine = new Engine(openDb(':memory:'), plain, { ...defaultConfig, adminPhone: ADMIN, publicUrl: 'https://sawari.example/' }, () => clock);
await plainEngine.handle({ id: 'p1', from: ADMIN, kind: 'text', text: 'admin' });
assert.ok((plain.last(ADMIN) as any).body.endsWith('\nhttps://sawari.example/dashboard'), 'plain-text address, single slash');
const noUrl = new MemorySender();
await new Engine(openDb(':memory:'), noUrl, { ...defaultConfig, adminPhone: ADMIN }, () => clock).handle({ id: 'p2', from: ADMIN, kind: 'text', text: 'admin' });
assert.ok((noUrl.last(ADMIN) as any).body.includes('PUBLIC_URL'), 'told to set PUBLIC_URL when there is no address');
step('"admin" gives the admin an Open-dashboard button (plain address on other channels); nobody else gets one');

const D6 = '919101010101'; // opened the driver link but actually wants a ride
await say(D6, 'DRIVER');
await pick(D6, 'lang:hi');
assert.equal(last(D6).t, 'text', 'the driver welcome has no buttons at all');
await say(D6, 'Hi');
assert.equal(q<{ name: string | null }>('SELECT name FROM drivers WHERE phone=?', D6).name, null, '"Hi" not saved as a name');
assert.deepEqual((last(D6) as any).buttons.map((b: { id: string }) => b.id), ['role:rider', 'role:driver'], 'asked: ride instead, or continue?');
await pick(D6, 'role:driver');
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', D6).state, 'drv_details', 'continue resumes the same step');
assert.equal(last(D6).t, 'text', 'and shows the one-message instructions again');
await say(D6, 'hello');
await pick(D6, 'role:rider');
assert.equal(q<{ c: number }>('SELECT COUNT(*) c FROM drivers WHERE phone=?', D6).c, 0, 'draft driver dropped');
assert.equal(last(D6).t, 'reqloc', 'switched straight into booking');
const D7 = '919202020202';
await say(D7, 'driver');
await pick(D7, 'lang:en');
await say(D7, 'Gopal');
await say(D7, 'cancel');
assert.equal(q<{ c: number }>('SELECT COUNT(*) c FROM drivers WHERE phone=?', D7).c, 0, 'cancel drops the draft');
assert.ok(texts(D7).at(-1)!.includes('registration stopped'));
await say(D7, 'hi');
assert.equal(last(D7).t, 'reqloc', 'after cancel, "hi" books a ride');
step('driver link but wants a ride: "hi" is not saved as a name, "Book a ride" switches over; cancel stops sign-up');

for (const [raw, want] of [
  ['UP85AB1234', 'UP85 AB 1234'], ['up 85 ab 1234', 'UP85 AB 1234'], ['DL3CAB1234', 'DL3 CAB 1234'],
  ['UP85 1234', 'UP85 1234'], ['22 BH 1234 AA', '22 BH 1234 AA'],
  ['nahi hai', null], ['1234', null], ['UP85', null], ['abc', null], ['UP85 AB 12345', null],
] as const) assert.equal(normalizePlate(raw), want, `plate ${raw}`);
const D4 = '919888888888';
await say(D4, 'driver');
await pick(D4, 'lang:hi');
await say(D4, 'Shyam');
await say(D4, 'number nahi hai');
await pick(D4, 'noplate');
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', D4).state, 'drv_details', 'seats are still missing');
assert.equal(q<{ vehicle_no: string | null }>('SELECT vehicle_no FROM drivers WHERE phone=?', D4).vehicle_no, null);
const seatsAsk = last(D4) as Extract<Out, { t: 'buttons' }>;
assert.deepEqual(seatsAsk.buttons.map((b) => b.id), ['seats:4', 'seats:5', 'seats:6'], 'only seats missing → seat buttons');
await pick(D4, 'seats:6');
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', D4).state, 'drv_photo', 'no plate is accepted, so on to the photo');
step('plate format checked and tidied; "no number plate" lets sign-up continue; seats offered as buttons when only they are missing');

// The form in one message, in any shape.
const form = async (phone: string, text: string) => { await say(phone, 'driver'); await pick(phone, 'lang:en'); await say(phone, text); return q<any>('SELECT name, vehicle_no, seats FROM drivers WHERE phone=?', phone); };
assert.deepEqual(await form('919301000001', 'Gopal Singh, RJ14 AB 9012, 6'), { name: 'Gopal Singh', vehicle_no: 'RJ14 AB 9012', seats: 6 });
assert.deepEqual(await form('919301000002', 'Name: Ravi Kumar, Vehicle: up-85 cd 4321, Seats: 4'), { name: 'Ravi Kumar', vehicle_no: 'UP85 CD 4321', seats: 4 }, 'labels are understood');
assert.deepEqual(await form('919301000003', '5 UP85EF1234 Mahesh Yadav'), { name: 'Mahesh Yadav', vehicle_no: 'UP85 EF 1234', seats: 5 }, 'any order, no commas');
assert.deepEqual(await form('919301000004', 'रमेश कुमार, UP85 AB 1234, 4'), { name: 'रमेश कुमार', vehicle_no: 'UP85 AB 1234', seats: 4 }, 'Hindi names');
for (const ph of ['919301000001', '919301000002', '919301000003', '919301000004']) assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', ph).state, 'drv_photo');
// A vehicle number that is not valid is asked for again, not stored.
assert.equal((await form('919301000005', 'Anil Kumar, UP85 AB 12345, 4')).vehicle_no, null, 'five digits is not a plate');
assert.ok((last('919301000005') as any).body.includes('vehicle number'), 'and the bot asks for it again');
// Only seats missing, then a re-sent full message corrects the name.
await form('919301000006', 'Tara Chand, UP85 IJ 3333');
assert.deepEqual((last('919301000006') as any).buttons.map((b: { id: string }) => b.id), ['seats:4', 'seats:5', 'seats:6']);
await say('919301000006', 'Tara Chand Sharma, UP85 IJ 3333, 5');
assert.equal(q<{ name: string }>('SELECT name FROM drivers WHERE phone=?', '919301000006').name, 'Tara Chand Sharma', 'a full re-send corrects the name');
// The photo with the details as its caption is the whole form in one message; the RC is then the only thing left.
const D8 = '919301000008';
await say(D8, 'driver'); await pick(D8, 'lang:en');
await go(D8, { kind: 'image', mediaId: 'media-photo-shyam', text: 'Shyam Lal, UP85 CD 4321, 4' });
const d8 = q<any>('SELECT name, vehicle_no, seats, photo_media_id FROM drivers WHERE phone=?', D8);
assert.deepEqual(d8, { name: 'Shyam Lal', vehicle_no: 'UP85 CD 4321', seats: 4, photo_media_id: 'media-photo-shyam' });
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', D8).state, 'drv_rc', 'photo + caption skips straight to the RC');
await pick(D8, 'rclater');
assert.equal(q<{ status: string }>('SELECT status FROM drivers WHERE phone=?', D8).status, 'pending');
// A photo without a caption is kept; the details sent afterwards then skip the photo step.
const D9 = '919301000009';
await say(D9, 'driver'); await pick(D9, 'lang:en');
await go(D9, { kind: 'image', mediaId: 'media-photo-ravi' });
assert.ok((last(D9) as any).body.includes('full name') && (last(D9) as any).body.includes('seats'), 'asks for the details');
await say(D9, 'Ravi Kumar, UP85 EF 1111, 4');
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', D9).state, 'drv_rc', 'the photo was kept, so the RC is next');
// Drivers caught part-way through the old step-by-step questions carry on in the new step.
const D10 = '919301000010';
await say(D10, 'driver'); await pick(D10, 'lang:en'); await say(D10, 'Old Timer');
db.prepare("UPDATE users SET state='drv_vehicle' WHERE phone=?").run(D10);
await say(D10, 'UP85 GH 2222, 5');
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', D10).state, 'drv_photo');
// Parsing, directly.
for (const [text, want] of [
  ['Ramesh Kumar, UP85 AB 1234, 4', { name: 'Ramesh Kumar', plate: 'UP85 AB 1234', seats: 4 }],
  ['I am Mohan Lal, my vehicle is RJ14 AB 9012 and seats 6', { name: 'Mohan Lal', plate: 'RJ14 AB 9012', seats: 6 }],
  ['4', { seats: 4 }], ['UP85 AB 1234', { plate: 'UP85 AB 1234' }], ['Ramesh Kumar', { name: 'Ramesh Kumar' }],
  ['5 seater', { seats: 5 }], ['Ramesh Kumar, 9876543210, 4', { name: 'Ramesh Kumar', seats: 4 }],
  ['Ramesh, UP85 AB 12345, 4', { name: 'Ramesh', seats: 4 }], ['Ramesh, ZZ85 AB 1234, 4', { name: 'Ramesh', seats: 4 }], ['22 BH 1234 AA, Gopal, 6', { name: 'Gopal', plate: '22 BH 1234 AA', seats: 6 }],
  ['9', {}], ['', {}],
] as const) assert.deepEqual(parseDriverDetails(text), want, `parse "${text}"`);
step('driver form in ONE message: any order, labels, Hindi, photo caption, only the missing parts re-asked, old mid-signup drivers carry on');

// ---------------------------------------------------------------- A2. wrong details: correct them, or restart
const status = (ph: string) => q<{ status: string }>('SELECT status FROM drivers WHERE phone=?', ph).status;
const field = (ph: string) => q<any>('SELECT name, vehicle_no, seats, photo_media_id, rc_media_id, on_duty, rides_done, rating_count FROM drivers WHERE phone=?', ph);
const stateOf = (ph: string) => q<{ state: string }>('SELECT state FROM users WHERE phone=?', ph).state;
const E1 = '919400000001';
await say(E1, 'driver'); await pick(E1, 'lang:en'); await say(E1, 'Ramesh Kumar, UP85 AB 1234, 4');
const echo = (last(E1) as any).body as string;
assert.ok(echo.includes('Name: Ramesh Kumar') && echo.includes('Vehicle: UP85 AB 1234') && echo.includes('Seats: 4') && echo.includes('"restart"'), 'what was understood is shown back, with the way to fix it');
// at the photo step: a corrected vehicle number or seat count is applied; a lone word is not
await say(E1, 'UP85 CD 5678');
assert.equal(field(E1).vehicle_no, 'UP85 CD 5678');
assert.equal(stateOf(E1), 'drv_photo', 'still waiting for the photo');
assert.ok((last(E1) as any).body.includes('Vehicle: UP85 CD 5678') && (last(E1) as any).body.includes('photo'), 'shows the corrected details and asks for the photo again');
await say(E1, 'Ramesh');
assert.equal(field(E1).name, 'Ramesh Kumar', 'a lone word is not a correction');
assert.equal((last(E1) as any).body, 'Please send it as a photo.', 'and gets the plain "send a photo" reply, not a details echo');
await say(E1, 'Ramesh K Sharma, 5'); // two fields: a deliberate correction of the name and the seats
assert.deepEqual([field(E1).name, field(E1).seats], ['Ramesh K Sharma', 5]);
await img(E1, 'e1-photo');
await say(E1, '6'); // at the RC step
assert.equal(field(E1).seats, 6);
assert.equal(stateOf(E1), 'drv_rc');
assert.ok((last(E1) as any).body.includes('Seats: 6') && (last(E1) as any).buttons.some((b: { id: string }) => b.id === 'rclater'), 'corrected, and the RC is asked for again');
await img(E1, 'e1-rc');
assert.equal(status(E1), 'pending');
assert.ok(texts(E1).at(-1)!.includes('"restart"'), 'the "submitted" message says how to start over');

// restart while waiting for approval: the form starts again, the old Approve button no longer works
await say(E1, 'hello there'); // ordinary text while pending: still says "under review" and how to restart
assert.ok(texts(E1).at(-1)!.includes('still under review') && texts(E1).at(-1)!.includes('"restart"'));
const alertsBefore = wa.to(ADMIN).length;
await say(E1, 'restart');
assert.deepEqual([status(E1), field(E1).name, field(E1).vehicle_no, field(E1).seats, field(E1).photo_media_id, field(E1).rc_media_id], ['draft', null, null, null, null, null]);
assert.equal(stateOf(E1), 'drv_details');
assert.ok((last(E1) as any).body.includes('ONE message'), 'the form starts again');
await pick(ADMIN, `adm:ok:${E1}`);
assert.equal(status(E1), 'draft', 'the old Approve button does not approve a driver who is re-registering');
assert.ok(texts(ADMIN).at(-1)!.includes('registering again'), 'and the admin is told why');
await say(E1, 'Ramesh Kumar, UP85 AB 1234, 4'); await img(E1, 'e1-photo2'); await img(E1, 'e1-rc2');
assert.equal(status(E1), 'pending');
assert.ok(wa.to(ADMIN).length > alertsBefore && bodies(ADMIN).at(-1)!.includes('UP85 AB 1234'), 'the admin gets a new request with the corrected details');
await pick(ADMIN, `adm:ok:${E1}`);
assert.equal(status(E1), 'approved');

// "driver" also starts over for a driver who is waiting or was rejected; the rejection says how
const E2 = '919400000002';
await say(E2, 'driver'); await pick(E2, 'lang:en'); await say(E2, 'Wrong Name, UP85 EF 1111, 4'); await img(E2, 'e2-photo'); await img(E2, 'e2-rc');
await say(E2, 'driver');
assert.equal(status(E2), 'draft', '"driver" restarts a pending registration');
await say(E2, 'Right Name, UP85 EF 1111, 4'); await img(E2, 'e2-photo'); await img(E2, 'e2-rc');
await engine.rejectDriver(E2);
assert.ok(texts(E2).at(-1)!.includes('"restart"'), 'the rejection message says how to register again');
await say(E2, 'driver');
assert.deepEqual([status(E2), stateOf(E2), field(E2).name], ['draft', 'drv_details', null], '"driver" restarts a rejected registration');
// mid sign-up (a draft) too
await say(E2, 'Third Try, UP85 EF 2222, 5');
assert.equal(stateOf(E2), 'drv_photo');
await say(E2, 'restart');
assert.deepEqual([status(E2), stateOf(E2), field(E2).name, field(E2).vehicle_no], ['draft', 'drv_details', null, null], 'restart works part-way through sign-up');

// an approved driver is asked first; "driver" alone just shows their menu
db.prepare('UPDATE drivers SET on_duty=1, rides_done=3, rating_sum=12, rating_count=3 WHERE phone=?').run(E1);
await say(E1, 'driver');
assert.equal(status(E1), 'approved', '"driver" does not restart an approved driver');
await say(E1, 'restart');
assert.deepEqual((last(E1) as any).buttons.map((b: { id: string }) => b.id), ['restart:yes', 'restart:no'], 'an approved driver must confirm');
assert.equal(status(E1), 'approved');
await pick(E1, 'restart:no');
assert.equal(status(E1), 'approved');
assert.ok(texts(E1).at(-1)!.includes('nothing changed'));
db.prepare("INSERT INTO rides(rider_phone, driver_phone, status, group_size, t_requested) VALUES ('919400009999', ?, 'matched', 2, 1)").run(E1);
await say(E1, 'restart');
assert.ok(texts(E1).at(-1)!.includes('ride in progress'), 'no restart while a ride is under way');
await pick(E1, 'restart:yes'); // even from an old button
assert.equal(status(E1), 'approved');
db.prepare("DELETE FROM rides WHERE rider_phone='919400009999'").run();
await say(E1, 'restart');
await pick(E1, 'restart:yes');
const e1 = field(E1);
assert.deepEqual([status(E1), e1.on_duty, e1.name, e1.rides_done, e1.rating_count], ['draft', 0, null, 3, 3], 'restarted: off duty and needs approval again, but rides and ratings are kept');
await pick(E1, 'restart:yes'); // a stale button is ignored
assert.equal(stateOf(E1), 'drv_details');
// someone who is not a driver typing "restart" does not become one
await say('919400000003', 'restart');
assert.equal(q<{ c: number }>("SELECT COUNT(*) c FROM drivers WHERE phone='919400000003'").c, 0);
step('wrong details: echoed back, corrected at the photo/RC step, "restart" (or "driver") starts over for waiting, rejected and in-progress drivers; approved drivers confirm first');

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

// A rider who types "hi" at "Want to say more?" wants a new ride; it must not be saved as the feedback note.
const ride1b = await riderRequest(R1, 'en', 'radha', 2, 27.497, 77.461);
await pick(D1, `qp:${ride1b}:200`);
await pick(D1, `qe:${ride1b}:200:5`);
await advance(181);
await pick(R1, (last(R1) as Extract<Out, { t: 'list' }>).rows[0].id);
await pick(D1, `arr:${ride1b}`);
const otp1b = q<{ otp: string }>('SELECT otp FROM rides WHERE id=?', ride1b).otp;
await pick(D1, `go:${ride1b}`);
await say(D1, otp1b);
await pick(D1, `done:${ride1b}`);
await pick(D1, `same:${ride1b}`);
await pick(D1, `pay:${ride1b}:cash:200`);
await pick(R1, `rc:${ride1b}:yes`);
await advance(301);
await pick(R1, `rate:${ride1b}:4`);
await pick(R1, `tag:${ride1b}:none`);
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', R1).state, 'r_note', 'asked for a note');
await say(R1, 'Hi');
const rating1b = q<any>("SELECT rating, note FROM ratings WHERE ride_id=? AND from_role='rider'", ride1b);
assert.equal(rating1b.note, null, '"Hi" is not saved as the feedback note');
assert.equal(rating1b.rating, 4, 'the rating itself is kept');
assert.equal(last(R1).t, 'reqloc', '"Hi" starts a new request');
assert.equal(q<{ state: string }>('SELECT state FROM users WHERE phone=?', R1).state, 'ask_pickup');
step('"hi" after rating starts a new ride instead of becoming the feedback note');

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
