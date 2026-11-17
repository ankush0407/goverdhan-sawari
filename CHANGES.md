# Change log

What changed in the code, where (file and line numbers) and why. Newest entry first.

**How to read line numbers:** each entry says which commit its line numbers refer to. Lines move as the code
changes, so to find the same spot later run `git show <commit>:<file> | sed -n '<from>,<to>p'`, or search for the
function name given next to each range.

**How to add an entry:** see the "Change log rule" in [CLAUDE.md](CLAUDE.md).

---

## 2026-11-17 — Admin dashboard: drivers with photo/RC, riders, rides with timelines

Commit `<HASH>` (on top of `d61ff58`). Line numbers below are for that commit.
Tests: `npm run typecheck`, `npm run sim` (15 flow checks), `npm run sim:tg`, and the new `npm run sim:admin` all pass.
The page itself was also exercised in the browser against a throwaway copy of the data (all four tabs, wrong and right
token, enlarging a photo, Approve, expanding a ride, phone-width layout).

### Why

Reviewing drivers meant curl commands and a raw database: no photos or RCs, no list of riders, epoch-millisecond times,
and no ride history. The old simulator page had an admin panel but only works when no chat channel is connected.

### What the admin now experiences

A page at `http://localhost:3000/dashboard` (any channel). Sign in with `ADMIN_TOKEN`. Overview with a "needs attention"
list; Drivers with photo and RC thumbnails and Approve/Reject; Riders; Rides with India-time stamps, feedback and a
click-through timeline. `/admin/rides.csv` now has readable India-time stamps plus names and the rider's note.

### `src/admin.ts` (new, 147 lines) — the admin API, moved out of `server.ts` so it can be tested

| Lines | What |
|---|---|
| 12–13 | `ist()`: epoch ms → `YYYY-MM-DD HH:MM:SS` India time (used by the CSV). |
| 15–19 | `safeEq` (constant-time token comparison) and `parseJson`. |
| 21–27 | `createAdminRouter({ db, engine, sender, token })`; every route needs `Authorization: Bearer <token>`; with no `ADMIN_TOKEN` configured the whole API answers 401 (same as before). |
| 31–38 | `GET /drivers?status=` — now also `draft` and `all`, with `created_at`, `loc_at`, `lat/lng`, `signup_step` (where an unfinished sign-up stopped) and `chat_name`. Default is still `pending`. |
| 39–40 | `POST /drivers/:phone/approve` and `/reject` — unchanged. |
| 43–52 | `GET /media/:kind/:phone` (`photo` or `rc`) — looks the file id up by phone (never takes an id from the caller), asks the chat platform for the bytes, and serves only `image/jpeg\|png\|webp` with `nosniff` (anything else is 415). 404 when there is no file or no way to fetch it. |
| 55–65 | `GET /riders` — every user who is not in `drivers`, with ride, completed and cancelled counts and last ride time. |
| 69–85 | `GET /rides?limit=` — newest first: names, route, fares, payment, cancel info, rider rating/tag/note, driver thumb, quotes received. The start code (`otp`) is deliberately left out. |
| 88–96 | `GET /rides/:id` — the ride's events in order (parsed) and every quote with driver names. |
| 99–126 | `GET /stats` — moved unchanged, plus `drivers.pending`. |
| 129–144 | `GET /rides.csv` — `t_*` columns now India time; added `rider_name`, `driver_name`, `rider_note`. |

### `src/server.ts` (112 lines; was 158)

| Lines | Change |
|---|---|
| 7 | Imports `createAdminRouter`. |
| 69 | Mounts it at `/admin`. This replaces the inline admin routes that were at lines 67–120 of `4b2aa3e`. |
| 71–73 | `GET /dashboard` serves `public/admin.html` (no caching; the page contains no data or token). |
| 107 | Startup log prints the dashboard URL. |

### `src/telegram.ts` lines 51–63 and `src/whatsapp.ts` lines 74, 85–98 — fetching uploads

`Sender` gets an optional `media(id)` (whatsapp.ts:74). `TelegramBot.media` calls `getFile`, then downloads from Telegram's
file host. `CloudSender.media` does the two WhatsApp hops (media id → URL, then bytes) with the bearer token. Both return
`undefined` on any failure. **The WhatsApp version is untested against live Meta.**

### `public/admin.html` (new, 410 lines) — the dashboard

| Lines | What |
|---|---|
| 7–111 | Styles: light/dark, phone-friendly (tables and tabs scroll sideways, cards stack under 520px). |
| 112–144 | Constants (12 h stale-location limit, 2 h stuck-ride limit, labels) and helpers; all times formatted in `Asia/Kolkata`. |
| 147–158 | State, `api()` (401 → signed out) and `getJSON()`. |
| 161–177 | `refresh()`: loads stats, drivers, riders and rides together every 10 s and redraws. |
| 180–195 | `showLogin()`, `signOut()`, `showApp()` — sign-in screen (token kept in this browser's localStorage). |
| 198–229 | Tabs and badges (`renderBadges`, `setTab`), `renderTab()` (toolbars), `renderList()`. |
| 231–258 | `match()` search helper and `overview()` — tiles and the "needs attention" list. |
| 261–290 | `thumb()` and `drivers()` — cards, Approve/Reject (reject asks first), unfinished sign-up step, missing plate/RC and stale-location warnings. |
| 293–299 | `riders()`. |
| 302–353 | `driverName()`, `eventText()` (303–320), `rideDetail()` (321–339), `rides()` (340–353) — table, filters, expandable timeline, quotes, details, feedback note. |
| 355–377 | Images: `showThumb()` and `loadImage()` (362–376) — photos fetched with the token, one shared request across redraws, a failed image retried after 60 s. |
| 380–407 | One click handler for tabs, rows, photos (lightbox) and buttons (380–401); Escape closes the lightbox; 10-second refresh (405); first load (407). |

All text from users (names, notes) is HTML-escaped before it is shown.

### `src/admin-sim.ts` (new, 189 lines) — `npm run sim:admin`

Seeds two submitted drivers, an unfinished one and a full ride with feedback, then calls the API over HTTP. Checks: token
rules (56–72), drivers by status and sign-up step (74–88), riders (118–124), rides and timeline
order and hidden start code (126–151), photos served only as images for known drivers (153–165), stats and CSV times
(167–180), and that the page carries no token (182–186). `package.json` line 13 adds the `sim:admin` script.

### `README.md` and `CHANGES.md`

README lines 37 (new script), 59–86 (dashboard and API), 96–97 (gaps), 111–113 (layout).

### Also done in this session (data, not code)

The unfinished driver sign-up for +91 82669 80305 (Umesh) was deleted from `telegram.sqlite` at the user's request: one row
each in `drivers`, `users` and `tg_links`, no rides or quotes. He signed up again three minutes after the dashboard was
started and is waiting for approval.

### Known gaps

- Voice notes in feedback can't be played in the dashboard (shown as "🎤 voice note").
- No button to delete an unfinished sign-up.
- The dashboard is plain HTTP; the token travels unencrypted on the local network. Put it behind HTTPS before using it
  over the internet.
- Found while testing: anything a rider types right after rating, even "hi", is saved as the feedback note and no new
  ride starts (`src/flow.ts` line 206: the `r_note` check runs before the greeting check). Ride 1's note reads "Need a ride".

---

## 2026-11-17 — Change log and instructions for Claude

Docs only; no code changed, so every line number in the entry below is still valid.

- `CHANGES.md` (new): this file. The entry below maps each change from `4b2aa3e` to file and line numbers.
- `CLAUDE.md` (new): the **Change log rule** (lines 5–20) — every code change must add an entry here, in the same
  commit, with what/why and post-change line numbers — plus the working rules (tests before commit, no secrets, Hindi
  and English kept in sync, WhatsApp button limits, one role per phone number) at lines 22–28.
- `README.md` lines 95–96: the layout section points at these two files.
- Tests: none needed (no code touched).

---

## 2026-11-16 — Telegram channel, safer driver sign-up, admin approve buttons, simulator UI

Commit `4b2aa3e` (on top of `2acc56b`, the zip as received). Line numbers below are for `4b2aa3e`.
Tests: `npm run sim` (15 flow checks) and `npm run sim:tg` (Telegram adapter) both pass.

### Why

WhatsApp needs Meta business verification, which was blocking testing on real phones. Telegram needs no approval,
so the same flow now runs there. Testing on Telegram also exposed rough edges in driver sign-up, fixed below.

### `src/telegram.ts` (new, 185 lines) — Telegram channel

| Lines | What |
|---|---|
| 7–17 | Helpers: `esc`/`html` turn WhatsApp-style `*bold*` and `_italic_` into Telegram HTML; `digits`; `commandToText` turns `/start DRIVER` into `DRIVER`, `/start` into `hi`, `/cancel` into `cancel`. |
| 19–28 | `Pending` type (a message held until the user shares their number); `TelegramBot implements Sender`, so `flow.ts` needs no change to use it. Creates table `tg_links (phone, chat_id)`. |
| 31–42 | `call()`: every Bot API request has a deadline (15 s; 40 s for long polling) via `AbortSignal.timeout`. Added after the bot froze ~45 min on a dropped connection. |
| 63–86 | Sender methods. Buttons and lists become inline keyboards; `location` is sent as a venue; `requestLocation` shows a "📍 Send my location" keyboard button. |
| 89–116 | `run()`: long polling, so no public URL or tunnel is needed. Logs the driver and rider deep links. Retries after 3 s on any failure. |
| 118–169 | `toIncoming()`: converts a Telegram update into the WhatsApp-shaped `Incoming`. Taps are acknowledged, the chosen option is written into the message and its buttons removed (no double taps). First contact asks for the phone number; the first message is kept and replayed once the number is shared. A *typed* number (line 160) is refused with a pointer to the button, because only the button proves the number is the user's. |
| 171–185 | `link()`: stores `phone ↔ chat_id`; rejects someone else's contact card. |

The phone number a user shares is their identity, so "numbers revealed only after a match" works as on WhatsApp.

### `src/telegram-sim.ts` (new, 115 lines) — adapter test

Runs a driver, an admin and a rider through `TelegramBot` against a fake Bot API (no network). Checks at lines 63, 76,
86, 108, 113: number linking, onboarding by buttons/text/photos, admin Approve and duty-on with the location button,
a full booking with numbers hidden until the pick, and bold formatting. Run with `npm run sim:tg`.

### `src/server.ts` — channel selection and dev simulator

| Lines | What |
|---|---|
| 2, 6 | New imports: `fileURLToPath`, `TelegramBot`. |
| 25–29 | `telegram` is created only when `TELEGRAM_BOT_TOKEN` is set and WhatsApp is not (WhatsApp wins if both are set). `channel` is the label shown in the startup log. |
| 31–38 | Starts the Telegram loop; logs `[in] +<phone> <kind> <replyId>` per message (who and what kind, never the text); exits with a clear message if the token is bad. |
| 44 | `/health` reports `cloud`, `telegram` or `dev-simulator`. |
| 124–148 | Dev simulator only when no channel is configured. `simInbox` records what each phone sent, `GET /sim/chat?phone=` interleaves both sides of a chat in order, and `GET /sim` serves the chat page. |
| 153–154 | Startup lines show the active channel and the simulator URL. |

### `src/flow.ts` — driver and rider flow

| Lines | Change |
|---|---|
| 33 | `Driver.vehicle_no` is now `string \| null` (a driver may have no plate). |
| 56 | `WANTS_RIDE` pattern: "ride", "book", "taxi", "sawari", "सवारी". |
| 72–79 | `normalizePlate()` (exported): accepts Indian plates (`UP85 AB 1234`, `UP85 1234`, `DL3 CAB 1234`) and Bharat series (`22 BH 1234 AA`), ignores case, spaces and dashes, returns a tidy form or `null`. Exactly four digits at the end — "UP85" alone is rejected. |
| 167–173 | `askRole()`: "Book a ride / I am a driver" buttons. |
| 208 | `riderText`: a typed message while in `ask_role` re-asks the question. |
| 383 | Rider confirmation shows "No number plate" when the driver has none. |
| 457–467 | `startDriver(u, langKnown)`: skips the language question when it is already known. |
| 469–492 | `driverOnboarding`: "hi"/"ride" mid-sign-up asks whether to switch (line 472) instead of saving it as a name; vehicle step validates the plate (479–487); RC step re-offers the skip button when the driver types text (490). |
| 494–504 | `driverWelcome()` (welcome + "Book a ride" button) and `askSwitch()` ("Book a ride" / "Continue as driver"). |
| 507–521 | `resumeOnboarding()` re-sends the prompt for the current step; `dropDraftDriver()` deletes a half-finished sign-up — **only** rows with status `draft`. |
| 523–532 | `askSeats()` and `askRc()` (RC prompt with a "Don't have it now" button), extracted so they can be re-sent. |
| 535–547 | `finishRegistration()`: shared end of sign-up with or without an RC. The admin alert now carries **Approve / Reject** buttons (`adm:ok:<phone>`, `adm:no:<phone>`) and flags a missing RC or plate. |
| 549–564 | `onImage`: a photo from a pending or approved driver with no RC on file is saved as the RC and the admin is told (560). |
| 647–655 | `role:` buttons: first-contact choice, and the switch out of driver sign-up (drops the draft, goes to pickup). |
| 681–687 | `adm:` buttons: approve/reject, honoured only when the sender is `ADMIN_PHONE`. |
| 688–696 | `noplate` (stores no plate, continues) and `rclater` (finishes sign-up with no RC). |
| 707–719 | `onLang`: the first time a number picks a language and is not a driver, asks rider-or-driver (717), so a driver who opened with "hi" is not forced into booking. |
| 783–788 | `onCancelText`: "cancel" during driver sign-up stops it with its own message instead of "ride cancelled". |

### `src/messages.ts` — new copy (English lines 7–9, 75–88; Hindi lines 152–154, 219–232)

`ask_role`, `role_rider`, `role_driver`, `drv_switch`, `btn_continue_driver`, `drv_signup_cancelled`,
`drv_bad_vehicle`, `btn_no_plate`, `no_plate`, `btn_rc_later`, `drv_pending_no_rc`, `drv_rc_received`.
The Hindi is machine-drafted — have a native speaker review it.

### `src/sim.ts` — flow test (now 15 checks)

| Lines | What |
|---|---|
| 4, 25 | Imports `normalizePlate`; `bodies()` reads every message body (admin alerts are now buttons, not plain text). |
| 49–52 | `riderRequest` answers the new "Book a ride" question. |
| 65–74 | New user asks rider-or-driver, picks driver, lands in onboarding. |
| 76–94 | Bad plate re-asked, RC skipped, RC sent later, admin informed both times. |
| 96–103 | Admin approves with the button; a non-admin cannot. |
| 105–127 | Driver link but wants a ride: "Hi" is not saved as a name, "Book a ride" switches over; "cancel" stops sign-up. |
| 129–142 | Plate formats, then "No number plate" lets sign-up continue. |

### `public/sim.html` (new, 253 lines) — dev simulator page

WhatsApp-style chat UI at `http://localhost:3000/sim`. Several phones side by side (default phones at line 96,
"Add phone" form at 71), tappable buttons and lists (`bubble()` at 142–175), 📍 and 📷, and an admin panel
(`refreshAdmin()` at 200) listing pending drivers with Approve/Reject, flagging a missing RC or plate (210–211), and
showing live stats. Only available when no channel is configured.

### Other files

| File | Change |
|---|---|
| `package.json` line 12 | New script `sim:tg`. |
| `.env.example` | `TELEGRAM_BOT_TOKEN` added; `BRAND` quoted (an unquoted value with a space breaks `source .env`). |
| `.gitignore` | Ignores `.DS_Store`. |
| `README.md` | Channels table, how to run each channel, new driver sign-up flow, admin Approve buttons, updated known gaps and file layout. |

### Known gaps (not fixed here)

- Admin view is API-only: no driver photo or RC viewing, `rides.csv` times are epoch milliseconds.
- Some copy still says "Tap 📎 → Location" (WhatsApp wording); on Telegram the 📍 button does it.
- The bot runs only while the process runs; it needs hosting for anything beyond a desk test.

---

## 2026-10-22 — Initial import

Commit `2acc56b`: the project as received in `goverdhan-sawari.zip`. WhatsApp Cloud API flow, admin API,
SQLite schema and end-to-end simulation.
