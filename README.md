# Govardhan Sawari — WhatsApp-native e-rickshaw matchmaking

One WhatsApp Business number *is* the platform. Riders and drivers each chat only with it.
Phone numbers are revealed to each side **only after a quote is accepted**.
Free matchmaking, no payments handled (cash/UPI between rider and driver, recorded for data).

## Flow

**Driver** — texts `DRIVER` → language → name → vehicle no. → seats → photo → RC photo → you approve → `duty` + location = on duty.

**Rider** — scans QR (opens chat, "hi") → language → pickup pin (or typed place) → drop (list) → group size → when.

- **Parikrama** → fixed fare (`PARIKRAMA_FARE_PER_SEAT × people`). Nearby drivers get Accept/Skip. First accept wins.
- **Anything else** → drivers pick a price + ETA (or type an amount). After `QUOTE_WINDOW_SEC` (or 5 quotes) the rider sees up to 5 quotes (cheapest first, with rating, ETA, photo) plus a reference fare once ≥3 similar rides are completed. Rider picks one.
- No quotes → radius widens once (`NEARBY_KM` → `WIDE_KM`), then the rider is told honestly.

**Trip** — match reveals numbers + pickup pin → driver "arrived" → rider gets a 4-digit code → driver types it to start → "complete" → final fare + cash/UPI → rider confirms "ride done / didn't happen".

**Feedback** — `FEEDBACK_DELAY_SEC` after completion: rider 1–5 stars → tag (polite / on time / fair price / overcharged / unsafe) → optional voice/text note. Driver gives 👍/👎 on the rider. Cancels and no-shows are logged with who and why.

## Run locally (no WhatsApp needed)

```bash
npm install
npm run sim        # scripted end-to-end test: onboarding, quotes, trip, feedback, cancel, no-drivers
ADMIN_TOKEN=secret npm start   # dev simulator on :3000
```

Dev simulator (only when `WA_*` is unset):

```bash
curl -XPOST localhost:3000/sim/send -H 'content-type: application/json' -d '{"from":"919800000001","text":"hi"}'
curl "localhost:3000/sim/outbox?to=919800000001"
# buttons/list picks:  {"from":"…","replyId":"lang:en"}   location: {"from":"…","lat":27.5,"lng":77.46}
```

## Connect real WhatsApp (Meta Cloud API)

1. developers.facebook.com → create app → add **WhatsApp**. Use the free test number first.
2. Copy **Phone number ID** → `WA_PHONE_NUMBER_ID`. Create a **System User** permanent token → `WA_TOKEN`. App secret → `WA_APP_SECRET`.
3. Deploy this service (below), then in WhatsApp → Configuration set callback URL `https://<host>/webhook`, verify token = your `WA_VERIFY_TOKEN`, subscribe to **messages**.
4. Add your pilot drivers' numbers as test recipients (test number allows 5). For go-live: business verification + your own number + display-name approval.
5. QR codes: `https://wa.me/<number>?text=hi` for riders, `https://wa.me/<number>?text=DRIVER` for drivers.

Copy `.env.example` → env vars on your host.

## Deploy

Needs a **persistent process + disk** (SQLite file + 5-second scheduler). Use Railway, Render, or Fly.io with a volume mounted at `DB_PATH`. Vercel/serverless will not work as-is. When volume grows, swap SQLite for Postgres (all SQL is in `flow.ts` / `server.ts`).

## Admin (Bearer `ADMIN_TOKEN`)

```
GET  /admin/drivers?status=pending
POST /admin/drivers/:phone/approve      (also reject)
GET  /admin/stats        match rate, completion rate, time to first quote, repeat riders, ratings
GET  /admin/rides.csv    one row per ride with every timestamp, fare, rating, tag, cancel reason
```
Set `ADMIN_PHONE` to get a WhatsApp ping when a driver finishes registering.

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

## Layout

```
src/messages.ts   all copy, Hindi + English
src/flow.ts       state machine, dispatch, quotes, trip, feedback, scheduler tick
src/whatsapp.ts   Cloud API sender, webhook parser, signature check, in-memory test sender
src/server.ts     webhook, admin API, dev simulator
src/db.ts         SQLite schema
src/sim.ts        end-to-end test
```
