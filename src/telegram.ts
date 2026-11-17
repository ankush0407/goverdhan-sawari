// Telegram stand-in for WhatsApp: the same Engine and flow, on real phones, with no Meta approval.
// Uses long polling, so it runs from a laptop with no public URL. Users are keyed by the phone
// number they share once, so "number revealed after match" works exactly as on WhatsApp.
import type { DB } from './db.js';
import type { Button, Incoming, Row, Sender } from './whatsapp.js';

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
/** WhatsApp *bold* / _italic_ → Telegram HTML. */
const html = (s: string) => esc(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>');
const digits = (p: string) => p.replace(/\D/g, '');
/** "/start DRIVER" (from a t.me/<bot>?start=DRIVER link) → "DRIVER"; "/start" → "hi"; "/cancel" → "cancel". */
const commandToText = (t: string) => {
  const m = t.match(/^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/s);
  if (!m) return t;
  if (m[1].toLowerCase() === 'start') return m[2]?.trim() || 'hi';
  return m[1];
};

type Pending = Omit<Incoming, 'from'>;

export class TelegramBot implements Sender {
  private api: string;
  private pending = new Map<number, Pending>(); // first message from a chat that has not shared its number yet

  constructor(token: string, private db: DB) {
    this.api = `https://api.telegram.org/bot${token}`;
    db.exec('CREATE TABLE IF NOT EXISTS tg_links (phone TEXT PRIMARY KEY, chat_id INTEGER NOT NULL UNIQUE)');
  }

  /** Every request has a deadline: a connection that died while the Mac slept must fail fast, not hang the bot. */
  private async call(method: string, body: object, timeoutMs = 15_000): Promise<any> {
    const res = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!j.ok) throw new Error(`Telegram ${method} failed: ${j.description}`);
    return j.result;
  }

  private chatOf(phone: string) {
    return (this.db.prepare('SELECT chat_id FROM tg_links WHERE phone=?').get(digits(phone)) as { chat_id: number } | undefined)?.chat_id;
  }
  private phoneOf(chatId: number) {
    return (this.db.prepare('SELECT phone FROM tg_links WHERE chat_id=?').get(chatId) as { phone: string } | undefined)?.phone;
  }

  /** Photo/RC bytes for the admin dashboard: getFile gives a path, then the file is fetched from Telegram's file host. */
  async media(id: string) {
    try {
      const f = (await this.call('getFile', { file_id: id })) as { file_path?: string };
      if (!f.file_path) return undefined;
      const res = await fetch(`${this.api.replace('/bot', '/file/bot')}/${f.file_path}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return undefined;
      const ext = f.file_path.split('.').pop()?.toLowerCase();
      const contentType = res.headers.get('content-type')?.startsWith('image/') ? res.headers.get('content-type')! : ext === 'png' ? 'image/png' : 'image/jpeg';
      return { contentType, data: Buffer.from(await res.arrayBuffer()) };
    } catch {
      return undefined;
    }
  }

  private async send(to: string, method: string, body: object) {
    const chat_id = this.chatOf(to);
    if (chat_id == null) {
      console.warn(`[tg] ${to} has not opened the bot yet; ${method} dropped`);
      return;
    }
    await this.call(method, { chat_id, ...body });
  }
  private inline(items: { id: string; title: string }[]) {
    return { inline_keyboard: items.map((b) => [{ text: b.title, callback_data: b.id }]) };
  }

  // ---------- Sender ----------
  async text(to: string, body: string) {
    await this.send(to, 'sendMessage', { text: html(body), parse_mode: 'HTML' });
  }
  async buttons(to: string, body: string, buttons: Button[]) {
    await this.send(to, 'sendMessage', { text: html(body), parse_mode: 'HTML', reply_markup: this.inline(buttons) });
  }
  async list(to: string, body: string, _buttonLabel: string, rows: Row[], header?: string) {
    const text = (header ? `<b>${esc(header)}</b>\n` : '') + html(body);
    const items = rows.map((r) => ({ id: r.id, title: r.description ? `${r.title} · ${r.description}` : r.title }));
    await this.send(to, 'sendMessage', { text, parse_mode: 'HTML', reply_markup: this.inline(items) });
  }
  async image(to: string, mediaId: string, caption: string) {
    await this.send(to, 'sendPhoto', { photo: mediaId, caption: html(caption), parse_mode: 'HTML' });
  }
  async location(to: string, lat: number, lng: number, name: string) {
    await this.send(to, 'sendVenue', { latitude: lat, longitude: lng, title: name, address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
  }
  async requestLocation(to: string, body: string) {
    await this.send(to, 'sendMessage', {
      text: html(body),
      parse_mode: 'HTML',
      reply_markup: { keyboard: [[{ text: '📍 Send my location / लोकेशन भेजें', request_location: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
  }

  // ---------- receiving ----------
  /** Long-poll Telegram forever, handing each update to `onMessage` as a WhatsApp-shaped Incoming. */
  async run(onMessage: (m: Incoming) => Promise<void>) {
    await this.call('deleteWebhook', {});
    const me = await this.call('getMe', {});
    console.log(`[tg] bot @${me.username} is live`);
    console.log(`[tg]   drivers: https://t.me/${me.username}?start=DRIVER`);
    console.log(`[tg]   riders:  https://t.me/${me.username}?start=hi`);
    let offset = 0;
    for (;;) {
      let updates: any[];
      try {
        updates = await this.call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'edited_message', 'callback_query'] }, 40_000);
      } catch (e) {
        console.error(`[tg] poll failed, retrying in 3s: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          const m = await this.toIncoming(u);
          if (m) await onMessage(m);
        } catch (e) {
          console.error('[tg] update', u.update_id, e);
        }
      }
    }
  }

  /** One Telegram update → Incoming, or undefined when there is nothing for the flow (yet). */
  async toIncoming(u: any): Promise<Incoming | undefined> {
    const id = `tg-${u.update_id}`;

    if (u.callback_query) {
      const q = u.callback_query;
      await this.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      const chatId: number | undefined = q.message?.chat?.id;
      const phone = chatId != null ? this.phoneOf(chatId) : undefined;
      if (!phone) return;
      const title: string = q.message?.reply_markup?.inline_keyboard?.flat().find((b: any) => b.callback_data === q.data)?.text ?? q.data;
      // Show the choice in the chat, as WhatsApp does, and retire the buttons so they can't be tapped twice.
      if (q.message?.text) {
        await this.call('editMessageText', {
          chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML',
          text: `${esc(q.message.text)}\n\n✅ <b>${esc(title)}</b>`,
        }).catch(() => {});
      }
      return { id, from: phone, name: q.from?.first_name, kind: 'reply', replyId: q.data, text: title };
    }

    const edited = !u.message && u.edited_message;
    const msg = u.message ?? u.edited_message;
    if (!msg || msg.chat?.type !== 'private') return;
    if (edited && !msg.location) return; // only Live Location updates matter among edits
    const chatId: number = msg.chat.id;

    if (msg.contact) return this.link(msg, id);

    const base = { id, name: msg.from?.first_name as string | undefined };
    let m: Pending;
    if (msg.location) m = { ...base, kind: 'location', lat: msg.location.latitude, lng: msg.location.longitude };
    else if (msg.photo) m = { ...base, kind: 'image', mediaId: msg.photo[msg.photo.length - 1].file_id };
    else if (msg.voice || msg.audio) m = { ...base, kind: 'audio', mediaId: (msg.voice ?? msg.audio).file_id };
    else if (typeof msg.text === 'string') m = { ...base, kind: 'text', text: commandToText(msg.text.trim()) };
    else m = { ...base, kind: 'other' };

    const phone = this.phoneOf(chatId);
    if (phone) return { ...m, from: phone };

    // First contact: we need their number before the flow can start. Keep what they said for afterwards,
    // unless it is a typed phone number — Telegram can only vouch for one shared with the button.
    const typedNumber = m.kind === 'text' && /^\+?[\d\s().-]{8,}$/.test(m.text ?? '');
    if (!typedNumber) this.pending.set(chatId, m);
    await this.call('sendMessage', {
      chat_id: chatId,
      text: typedNumber
        ? 'Please don\'t type the number — tap the "📱 Share my phone number" button below, so Telegram confirms it is yours.\nनंबर टाइप न करें — नीचे "📱 Share my phone number" बटन दबाएँ।\n\nDon\'t see the button? Tap the ⌨️ / 🎛 icon next to the message box. / बटन न दिखे तो मैसेज बॉक्स के पास ⌨️ / 🎛 आइकन दबाएँ।'
        : '🙏 Govardhan Sawari\n\nTo connect riders and drivers we need your phone number. It is shared with the other person only after a ride is confirmed.\nTap the "📱 Share my phone number" button below.\n\nनंबर शेयर करने के लिए नीचे का बटन दबाएँ।',
      reply_markup: { keyboard: [[{ text: '📱 Share my phone number / नंबर शेयर करें', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
  }

  private async link(msg: any, id: string): Promise<Incoming | undefined> {
    const chatId: number = msg.chat.id;
    if (msg.contact.user_id !== msg.from?.id) {
      await this.call('sendMessage', { chat_id: chatId, text: 'Please share your own number with the button below. / कृपया नीचे के बटन से अपना ही नंबर भेजें।' });
      return;
    }
    const phone = digits(msg.contact.phone_number);
    this.db.prepare('DELETE FROM tg_links WHERE chat_id=? OR phone=?').run(chatId, phone);
    this.db.prepare('INSERT INTO tg_links(phone, chat_id) VALUES (?, ?)').run(phone, chatId);
    await this.call('sendMessage', { chat_id: chatId, text: `✅ +${phone}`, reply_markup: { remove_keyboard: true } });
    const first = this.pending.get(chatId);
    this.pending.delete(chatId);
    return { ...(first ?? { id, kind: 'text', text: 'hi' }), from: phone };
  }
}
