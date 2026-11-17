# Govardhan Sawari — WhatsApp-native e-rickshaw matchmaking

One WhatsApp Business number *is* the platform. Riders and drivers each chat only with it.
Phone numbers are revealed to each side **only after a quote is accepted**.
Free matchmaking, no payments handled (cash/UPI between rider and driver, recorded for data).

## Flow

**Driver** — texts `DRIVER` → language → name → vehicle no. (Indian plate format checked, or "No number plate") → seats → photo → RC photo (or "Don't have it now", send later) → admin taps Approve → `duty` + location = on duty. Typing "hi"/"ride" mid-signup offers to switch to booking a ride; "cancel" stops signup.

**Rider** — scans QR (opens chat, "hi") → language → *first contact only:* "Book a ride / I am a driver" → pickup pin (or typed place) → drop (list) → group size → when.

- **Parikrama** → fixed fare (`PARIKRAMA_FARE_PER_SEAT × people`). Nearby drivers get Accept/Skip. First accept wins.
- **Anything else** → drivers pick a price + ETA (or type an amount). After `QUOTE_WINDOW_SEC` (or 5 quotes) the rider sees up to 5 quotes (cheapest first, with rating, ETA, photo) plus a reference fare once ≥3 similar rides are completed. Rider picks one.
- No quotes → radius widens once (`NEARBY_KM` → `WIDE_KM`), then the rider is told honestly.

**Trip** — match reveals numbers + pickup pin → driver "arrived" → rider gets a 4-digit code → driver types it to start → "complete" → final fare + cash/UPI → rider confirms "ride done / didn't happen".

**Feedback** — `FEEDBACK_DELAY_SEC` after completion: rider 1–5 stars → tag (polite / on time / fair price / overcharged / unsafe) → optional voice/text note (typing "hi" or "ride" there starts a new request instead). Driver gives 👍/👎 on the rider. Cancels and no-shows are logged with who and why.

## Channels

The flow (`src/flow.ts`) talks to a `Sender`; the server picks the channel from env:

| Env set | Channel |
|---|---|
| `WA_PHONE_NUMBER_ID` + `WA_TOKEN` | WhatsApp Cloud API (production) |
| `TELEGRAM_BOT_TOKEN` (and no `WA_*`) | Telegram bot — real phones while Meta approval is pending |
| neither | Dev simulator: chat UI at `/sim` |

## Run locally (no WhatsApp needed)

```bash
npm install
npm run sim        # end-to-end test of the whole flow
npm run sim:tg     # Telegram adapter against a fake Bot API
npm run sim:admin  # admin API and dashboard data
cp .env.example .env   # then fill it in
set -a && source .env && set +a && npm start
```

**Dev simulator** (no channel configured): open `http://localhost:3000/sim` — several phones side by side, tappable buttons, 📍/📷, plus an admin panel to approve drivers and see stats. Raw endpoints: `POST /sim/send`, `GET /sim/outbox?to=…`, `GET /sim/chat?phone=…`.

**Telegram** (`TELEGRAM_BOT_TOKEN` from @BotFather): long polling, so no public URL or tunnel. Each user shares their phone number once with Telegram's button; that number is their identity, so "numbers revealed only after a match" works as on WhatsApp. Links: `https://t.me/<bot>?start=DRIVER` for drivers, `?start=hi` for riders. The bot runs as long as this process does — host it (below) for anything beyond a desk test.

## Connect real WhatsApp (Meta Cloud API)

1. developers.facebook.com → create app → add **WhatsApp**. Use the free test number first.
2. Copy **Phone number ID** → `WA_PHONE_NUMBER_ID`. Create a **System User** permanent token → `WA_TOKEN`. App secret → `WA_APP_SECRET`.
3. Deploy this service (below), then in WhatsApp → Configuration set callback URL `https://<host>/webhook`, verify token = your `WA_VERIFY_TOKEN`, subscribe to **messages**.
4. Add your pilot drivers' numbers as test recipients (test number allows 5). For go-live: business verification + your own number + display-name approval.
5. QR codes: `https://wa.me/<number>?text=hi` for riders, `https://wa.me/<number>?text=DRIVER` for drivers.

Copy `.env.example` → env vars on your host.

## Deploy

Needs a **persistent process + disk** (SQLite file + 5-second scheduler). Use Railway, Render, or Fly.io with a volume mounted at `DB_PATH`. Vercel/serverless will not work as-is. When volume grows, swap SQLite for Postgres (all SQL is in `flow.ts` / `server.ts`).

## Admin

**Dashboard:** open `http://localhost:3000/dashboard` and enter `ADMIN_TOKEN` (from `.env`). Works in every channel. Tabs:

- **Overview** — headline numbers and a "needs attention" list (drivers waiting for approval, approved without an RC, on duty with a stale location, rides open for more than 2 hours).
- **Drivers** — cards with the driver's photo and RC (click to enlarge), plate, seats, rating, location freshness, and Approve / Reject. Unfinished sign-ups show the step they stopped at.
- **Riders** — everyone who is not a driver, with ride counts.
- **Rides** — newest first, times in India time, feedback at a glance; click a row for the full timeline, every quote, pickup, cancel reason and the rider's note.

The page refreshes every 10 seconds, works on a phone (same Wi-Fi: `http://<your-mac-ip>:3000/dashboard`), and holds no data itself: it calls the API below with the token. It is plain HTTP, so use it on a trusted network or put it behind HTTPS before exposing it to the internet.

**API** (Bearer `ADMIN_TOKEN`):

```
GET  /admin/drivers?status=pending|approved|rejected|draft|all   (default pending)
POST /admin/drivers/:phone/approve      (also reject)
GET  /admin/media/photo/:phone          driver photo (also /rc/:phone), fetched from the chat platform
GET  /admin/riders                      riders with ride counts
GET  /admin/rides?limit=200             rides with names, fare, rating, tag, note
GET  /admin/rides/:id                   that ride's events and quotes
GET  /admin/stats        match rate, completion rate, time to first quote, repeat riders, ratings
GET  /admin/rides.csv    one row per ride: names, fare, rating, tag, note, cancel reason, India-time stamps
```
Set `ADMIN_PHONE` (digits with country code, e.g. `919812345678`) to get a chat alert with **Approve / Reject** buttons when a driver finishes registering. Only that number can use them.

## Before you rely on it — known gaps

- **Fare is a placeholder** (₹50/seat). Set the real going rate.
- **Hindi copy is machine-drafted.** Have a native speaker from Goverdhan read every line in `src/messages.ts`.
- **24-hour window:** WhatsApp only lets you message a user freely for 24h after *their* last message. Drivers must message the number (e.g. tap Duty ON) at the start of each shift, otherwise ride offers need pre-approved templates (per-message cost). Not built here.
- **Driver photos in quotes** reuse the media ID from the driver's upload. Untested against live Meta; failure is swallowed and the list still sends.
- **No payments.** Cash/UPI is self-reported. Escrow/payout needs a licensed aggregator (Razorpay Route / Cashfree) — Phase 2.
- **Driver location goes stale** unless they share Live Location; offers only go to drivers who shared a location in the last 12h.
- **Disintermediation** is expected once numbers are revealed; the ride log + OTP + ratings are your signal that matches became real rides.
- Riders can't also be drivers from the same number. RC/ID are collected as photos only; you verify manually.
- Interactive limits respected: ≤3 buttons, ≤10 list rows, title lengths clamped.
- **Dashboard gaps:** voice notes can't be played, there is no button to delete an unfinished sign-up, and photo/RC fetching has only been tried against Telegram (the WhatsApp path is written but untested against live Meta).
- **Feedback note capture:** a full sentence typed at "Want to say more?" is saved as the note even if it was meant as a new request (e.g. "Need a ride"); the thank-you reply tells the rider to type "hi". Only a bare greeting or ride word starts a new request.
- Some copy still says "Tap 📎 → Location" (WhatsApp wording); on Telegram the 📍 button does it.

## Layout

```
src/messages.ts   all copy, Hindi + English
src/flow.ts       state machine, dispatch, quotes, trip, feedback, scheduler tick
src/whatsapp.ts   Cloud API sender, webhook parser, signature check, in-memory test sender
src/telegram.ts   Telegram stand-in: same Sender interface, long polling, phone-number linking
src/server.ts     channel selection, webhook, admin API, dev simulator
src/db.ts         SQLite schema
src/sim.ts        end-to-end test of the flow
src/telegram-sim.ts  Telegram adapter test against a fake Bot API
src/admin.ts      admin API (drivers, riders, rides, images, stats, CSV)
src/admin-sim.ts  admin API test against a seeded in-memory database
public/admin.html admin dashboard page (served at /dashboard)
public/sim.html   dev simulator chat UI + admin panel
CHANGES.md        what changed, with file and line numbers (newest first)
CLAUDE.md         working rules, including the rule for keeping CHANGES.md up to date
```
