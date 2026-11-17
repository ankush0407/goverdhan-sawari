# Govardhan Sawari — instructions for Claude

WhatsApp-native e-rickshaw matchmaking, with a Telegram channel for testing. Read `README.md` for the flow and layout.

## Change log rule (always)

Every time you change code in this repo, record it in `CHANGES.md` **in the same commit as the change**.

1. Add a new entry at the **top** of `CHANGES.md` (newest first), headed `## YYYY-MM-DD — short title`.
2. For each file you touched, say **what** changed and **why**, with **line numbers**:
   - Use the line numbers **after** your change (read them from the file, don't guess), and give the function or
     section name next to each range so the spot can be found again after lines move.
   - New files: give the total line count and a table of what lives where.
   - Behaviour changes: say what the user (driver, rider, admin) now experiences.
3. State which commit the line numbers refer to. Commit first, then fill in the hash, then amend or add a docs commit —
   `CHANGES.md` itself never shifts the line numbers of other files.
4. List the tests you ran and their result (`npm run sim`, `npm run sim:tg`, `npm run typecheck`).
5. Add any new gap or follow-up under "Known gaps". Remove a gap when you fix it.
6. If you add or change a user-visible message, say so — the Hindi copy is machine-drafted and needs human review.
7. Doc-only or config-only changes still get an entry (a short one).

## Working rules

- Run `npm run typecheck`, `npm run sim` and `npm run sim:tg` before committing; all must pass.
- Never commit `.env`, `*.sqlite*` or tokens. `.gitignore` covers them; check `git status` before `git add`.
- Keep Hindi and English in `src/messages.ts` in sync: a key added to `en` must exist in `hi`.
- WhatsApp limits: at most 3 buttons per message, 10 list rows, titles clamped (20 / 24 chars).
- Driver and rider cannot share a phone number. Numbers are revealed to the other side only after a match.
