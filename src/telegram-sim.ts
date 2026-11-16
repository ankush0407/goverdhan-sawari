// Telegram adapter test against a fake Telegram Bot API. Run with `npm run sim:tg`.
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { Engine, defaultConfig } from './flow.js';
import { TelegramBot } from './telegram.js';

type Call = { method: string; body: any };
const calls: Call[] = [];
let msgId = 0;
globalThis.fetch = (async (url: string, init: any) => {
  const method = String(url).split('/').pop()!;
  const body = JSON.parse(init.body);
  calls.push({ method, body });
  const result = method === 'getMe' ? { username: 'sawari_test_bot' } : method.startsWith('send') ? { message_id: ++msgId } : true;
  return new Response(JSON.stringify({ ok: true, result }));
}) as typeof fetch;

let clock = 1_700_000_000_000;
const db = openDb(':memory:');
const ADMIN = '919000000000';
const bot = new TelegramBot('TEST', db);
const engine = new Engine(db, bot, { ...defaultConfig, adminPhone: ADMIN }, () => clock);

const DRV = 101, ADM = 900, RDR = 202;
let updateId = 0;
const deliver = async (u: object) => {
  const m = await bot.toIncoming({ update_id: ++updateId, ...u });
  if (m) await engine.handle(m);
};
const chat = (id: number) => ({ id, type: 'private' });
const from = (id: number, first_name = 'User') => ({ id, first_name });
const text = (id: number, t: string) => deliver({ message: { message_id: ++msgId, chat: chat(id), from: from(id), text: t } });
const contact = (id: number, phone: string, owner = id) =>
  deliver({ message: { message_id: ++msgId, chat: chat(id), from: from(id), contact: { phone_number: phone, user_id: owner } } });
const loc = (id: number, latitude: number, longitude: number) =>
  deliver({ message: { message_id: ++msgId, chat: chat(id), from: from(id), location: { latitude, longitude } } });
const photo = (id: number, fileId: string) =>
  deliver({ message: { message_id: ++msgId, chat: chat(id), from: from(id), photo: [{ file_id: `${fileId}-small` }, { file_id: fileId }] } });
/** Tap the button with callback_data `data` on the latest message to `id` that has it. */
const tap = (id: number, data: string) => {
  const sent = [...calls].reverse().find((c) => c.body.chat_id === id && c.body.reply_markup?.inline_keyboard?.flat().some((b: any) => b.callback_data === data));
  assert.ok(sent, `no button ${data} shown to chat ${id}`);
  return deliver({ callback_query: { id: `cb${updateId}`, from: from(id), data, message: { message_id: 1, chat: chat(id), text: sent!.body.text, reply_markup: sent!.body.reply_markup } } });
};
const to = (id: number) => calls.filter((c) => c.body.chat_id === id);
const lastTo = (id: number) => to(id).at(-1)!;
const status = (phone: string) => (db.prepare('SELECT status, on_duty FROM drivers WHERE phone=?').get(phone) as any);
const step = (s: string) => console.log(`✓ ${s}`);

// ---------- linking ----------
await text(DRV, '/start DRIVER');
assert.ok(lastTo(DRV).body.reply_markup.keyboard[0][0].request_contact, 'unknown chat asked to share number');
await text(DRV, '+1 206 751 5313');
assert.match(lastTo(DRV).body.text, /don't type the number/, 'typed number gets a pointer to the button');
assert.ok(lastTo(DRV).body.reply_markup.keyboard[0][0].request_contact, 'button offered again');
await contact(DRV, '555', 999);
assert.match(lastTo(DRV).body.text, /own number/, 'someone else\'s contact refused');
await contact(DRV, '+91 91111 11111');
assert.ok(to(DRV).some((c) => c.body.text === '✅ +919111111111'), 'number linked');
assert.ok(lastTo(DRV).body.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === 'lang:hi'), 'pending "/start DRIVER" replayed → language prompt');
await text(ADM, '/start');
await contact(ADM, '919000000000');
step('first message asks for the phone number, then replays what they sent; others\' contacts refused');

// ---------- driver onboarding over Telegram ----------
await tap(DRV, 'lang:en');
assert.ok(calls.some((c) => c.method === 'answerCallbackQuery'), 'tap acknowledged');
assert.ok(calls.some((c) => c.method === 'editMessageText' && c.body.text.includes('✅ <b>English</b>')), 'choice shown in chat, buttons retired');
assert.match(lastTo(DRV).body.text, /Welcome, driver/);
await text(DRV, 'Ramesh Kumar');
await text(DRV, 'up85 ab 1234');
await tap(DRV, 'seats:4');
await photo(DRV, 'FILE-ramesh');
await photo(DRV, 'FILE-rc');
assert.equal(status('919111111111').status, 'pending');
step('driver onboarding: buttons, typed text and photos all map onto the flow');

// ---------- admin approves from Telegram ----------
assert.match(lastTo(ADM).body.text, /Driver pending approval: Ramesh Kumar · UP85 AB 1234 · 4 seats/);
await tap(ADM, 'adm:ok:919111111111');
assert.equal(status('919111111111').status, 'approved');
await tap(DRV, 'duty:on');
assert.ok(lastTo(DRV).body.reply_markup.keyboard[0][0].request_location, 'duty asks for location with a Telegram location button');
await loc(DRV, 27.498, 77.462);
assert.equal(status('919111111111').on_duty, 1);
step('admin taps Approve in their own chat; driver goes on duty with the location button');

// ---------- rider books, driver quotes, numbers revealed ----------
await text(RDR, 'hi');
await contact(RDR, '919333333333');
await tap(RDR, 'lang:en');
await tap(RDR, 'role:rider');
await loc(RDR, 27.497, 77.461);
await tap(RDR, 'drop:mansi');
await tap(RDR, 'grp:2');
await tap(RDR, 'when:now');
const rideId = (db.prepare('SELECT MAX(id) id FROM rides').get() as { id: number }).id;
await tap(DRV, `qp:${rideId}:200`);
await tap(DRV, `qe:${rideId}:200:5`);
clock += (defaultConfig.quoteWindowSec + 1) * 1000;
await engine.tick();
assert.ok(to(RDR).some((c) => c.method === 'sendPhoto' && c.body.photo === 'FILE-ramesh'), 'rider sees the driver photo from their upload');
assert.ok(!to(RDR).some((c) => JSON.stringify(c.body).includes('9111111111')), 'driver number hidden before pick');
await tap(RDR, 'pick:1');
assert.ok(to(RDR).some((c) => c.body.text?.includes('+919111111111')), 'rider gets driver number after pick');
assert.ok(to(DRV).some((c) => c.body.text?.includes('+919333333333')), 'driver gets rider number after pick');
assert.ok(to(DRV).some((c) => c.method === 'sendVenue' && c.body.latitude === 27.497), 'driver gets pickup pin');
step('rider books, driver quotes, quote shows driver photo, numbers revealed only after the pick');

// ---------- formatting ----------
await tap(DRV, `arr:${rideId}`);
assert.ok(to(RDR).some((c) => /<b>\d{4}<\/b>/.test(c.body.text ?? '')), 'WhatsApp *bold* start code rendered as Telegram bold');
step('WhatsApp-style *bold* renders as Telegram bold');

console.log(`\nTELEGRAM ADAPTER CHECKS PASSED — ${calls.length} Bot API calls`);
