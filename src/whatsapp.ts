import { createHmac, timingSafeEqual } from 'node:crypto';
import { clamp } from './messages.js';

// ---------- inbound ----------
export type Incoming = {
  id: string;
  from: string; // wa_id, e.g. 919876543210
  name?: string;
  kind: 'text' | 'reply' | 'location' | 'image' | 'audio' | 'other';
  text?: string;
  replyId?: string;
  lat?: number;
  lng?: number;
  mediaId?: string;
};

/** Flatten a WhatsApp Cloud API webhook payload into Incoming messages. */
export function parseWebhook(body: any): Incoming[] {
  const out: Incoming[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
      const names: Record<string, string> = {};
      for (const c of v?.contacts ?? []) names[c.wa_id] = c?.profile?.name;
      for (const m of v?.messages ?? []) {
        const base = { id: m.id as string, from: m.from as string, name: names[m.from] };
        switch (m.type) {
          case 'text':
            out.push({ ...base, kind: 'text', text: m.text?.body ?? '' });
            break;
          case 'interactive': {
            const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
            if (r) out.push({ ...base, kind: 'reply', replyId: r.id, text: r.title });
            break;
          }
          case 'location':
            out.push({ ...base, kind: 'location', lat: m.location?.latitude, lng: m.location?.longitude, text: m.location?.name });
            break;
          case 'image':
            out.push({ ...base, kind: 'image', mediaId: m.image?.id });
            break;
          case 'audio':
            out.push({ ...base, kind: 'audio', mediaId: m.audio?.id });
            break;
          default:
            out.push({ ...base, kind: 'other' });
        }
      }
    }
  }
  return out;
}

export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// ---------- outbound ----------
export type Button = { id: string; title: string };
export type Row = { id: string; title: string; description?: string };

export interface Sender {
  text(to: string, body: string): Promise<void>;
  buttons(to: string, body: string, buttons: Button[]): Promise<void>;
  list(to: string, body: string, buttonLabel: string, rows: Row[], header?: string): Promise<void>;
  image(to: string, mediaId: string, caption: string): Promise<void>;
  location(to: string, lat: number, lng: number, name: string): Promise<void>;
  requestLocation(to: string, body: string): Promise<void>;
}

export class CloudSender implements Sender {
  constructor(
    private phoneNumberId: string,
    private token: string,
    private version = 'v21.0',
  ) {}

  private async post(payload: object) {
    const res = await fetch(`https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[wa] send failed', res.status, err.slice(0, 500));
      throw new Error(`WhatsApp send failed: ${res.status}`);
    }
  }

  text(to: string, body: string) {
    return this.post({ to, type: 'text', text: { body, preview_url: false } });
  }
  buttons(to: string, body: string, buttons: Button[]) {
    return this.post({
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: clamp(body, 1024) },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: clamp(b.title, 20) } })) },
      },
    });
  }
  list(to: string, body: string, buttonLabel: string, rows: Row[], header?: string) {
    return this.post({
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        ...(header ? { header: { type: 'text', text: clamp(header, 60) } } : {}),
        body: { text: clamp(body, 1024) },
        action: {
          button: clamp(buttonLabel, 20),
          sections: [
            {
              title: ' ',
              rows: rows.slice(0, 10).map((r) => ({
                id: r.id,
                title: clamp(r.title, 24),
                ...(r.description ? { description: clamp(r.description, 72) } : {}),
              })),
            },
          ],
        },
      },
    });
  }
  image(to: string, mediaId: string, caption: string) {
    return this.post({ to, type: 'image', image: { id: mediaId, caption: clamp(caption, 1024) } });
  }
  location(to: string, lat: number, lng: number, name: string) {
    return this.post({ to, type: 'location', location: { latitude: lat, longitude: lng, name } });
  }
  requestLocation(to: string, body: string) {
    return this.post({
      to,
      type: 'interactive',
      interactive: { type: 'location_request_message', body: { text: clamp(body, 1024) }, action: { name: 'send_location' } },
    });
  }
}

/** In-memory sender for dev + tests. Keeps an outbox you can inspect. */
export type Out =
  | { to: string; t: 'text'; body: string }
  | { to: string; t: 'buttons'; body: string; buttons: Button[] }
  | { to: string; t: 'list'; body: string; header?: string; rows: Row[] }
  | { to: string; t: 'image'; mediaId: string; caption: string }
  | { to: string; t: 'location'; lat: number; lng: number; name: string }
  | { to: string; t: 'reqloc'; body: string };

export class MemorySender implements Sender {
  outbox: Out[] = [];
  constructor(private echo = false) {}
  private push(o: Out) {
    this.outbox.push(o);
    if (this.echo) console.log(`→ ${o.to}`, JSON.stringify(o));
  }
  async text(to: string, body: string) { this.push({ to, t: 'text', body }); }
  async buttons(to: string, body: string, buttons: Button[]) { this.push({ to, t: 'buttons', body, buttons }); }
  async list(to: string, body: string, _b: string, rows: Row[], header?: string) { this.push({ to, t: 'list', body, header, rows }); }
  async image(to: string, mediaId: string, caption: string) { this.push({ to, t: 'image', mediaId, caption }); }
  async location(to: string, lat: number, lng: number, name: string) { this.push({ to, t: 'location', lat, lng, name }); }
  async requestLocation(to: string, body: string) { this.push({ to, t: 'reqloc', body }); }
  to(phone: string) { return this.outbox.filter((o) => o.to === phone); }
  last(phone: string) { const a = this.to(phone); return a[a.length - 1]; }
  clear() { this.outbox = []; }
}
