// Telegram Mini App sign-in. When the dashboard is opened from a bot's web_app button, Telegram passes it
// "launch data" signed with a key derived from the bot token, so the server can tell which Telegram account
// opened the page without any password. Only someone holding the bot token can produce a valid signature.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type LaunchUser = { id: number };

/**
 * Checks launch data the way Telegram documents it: HMAC-SHA256 over the sorted `key=value` lines
 * (every field except `hash`), keyed by HMAC-SHA256("WebAppData", bot token). Returns the Telegram user,
 * or null if the signature is wrong, the data is too old, or it carries no user.
 */
export function verifyInitData(initData: string, botToken: string, opts: { maxAgeSec?: number; now?: number } = {}): LaunchUser | null {
  const { maxAgeSec = 24 * 3600, now = Date.now() } = opts;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');

  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  if (!timingSafeEqual(Buffer.from(hash), Buffer.from(expected))) return null; // both are 64 hex characters

  const ageSec = now / 1000 - Number(params.get('auth_date'));
  if (!Number.isFinite(ageSec) || ageSec > maxAgeSec || ageSec < -60) return null; // stale, or from the future

  try {
    const user = JSON.parse(params.get('user') ?? '');
    return typeof user?.id === 'number' ? { id: user.id } : null;
  } catch {
    return null;
  }
}
