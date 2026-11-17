# Change log

What changed in the code, where (file and line numbers) and why. Newest entry first.

**How to read line numbers:** each entry says which commit its line numbers refer to. Lines move as the code
changes, so to find the same spot later run `git show <commit>:<file> | sed -n '<from>,<to>p'`, or search for the
function name given next to each range.

**How to add an entry:** see the "Change log rule" in [CLAUDE.md](CLAUDE.md).

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
