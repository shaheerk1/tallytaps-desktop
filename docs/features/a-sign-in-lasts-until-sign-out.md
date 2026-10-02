# A sign-in lasts until someone signs out

Status: delivered 2026-10-02 (migration 126)
Applies to: `desktop-app` (every screen; the sign-in itself)

A sign-in used to be given twelve hours and then die wherever it stood, with
`Your session has ended. Sign in again.` on top of whatever was half typed. A
market day runs longer than that, and the counter is the same counter all day,
so the clock only ever went off at a bad moment.

A sign-in now has **no end date**. It ends when someone ends it:

- signing out, which is unchanged and still closes the workstation session;
- the account being set to anything but active;
- the workstation or location being taken out of use, which already stops a
  session from carrying any origin.

## What changed

- `sessions.expires_at` is nullable, and **NULL means no end**. The column is
  declared without a default so a server with `explicit_defaults_for_timestamp`
  off cannot stamp a new date on every update to the row.
- A row that does carry a date is still honoured, and the cleanup
  (`auth.cleanup`) still sweeps those away once the date passes — it no longer
  touches rows that have none. Sign-ins made before this change and still live
  were cleared of their date by the migration, so nobody was thrown out by the
  upgrade itself.
- Nothing else about identity moved: every request still resolves the user, the
  permissions, the workstation and the business date from the database through
  `session-context.service`, never from the screen.

## What this costs

The token in a counter's `localStorage` now works until that counter signs out,
so whoever is at the keyboard is whoever last signed in, and their name goes on
the bills. That was already true for the twelve hours a shift fits inside; what
is gone is the nightly forced re-entry. If attribution per person matters at a
counter, the shop's own habit of signing out at the end of a shift is what
carries it — the clock never did it well.

Verify: `npm run verify:session-lasts` — no end date on a new sign-in, a date
still honoured where one is set, the cleanup leaving the undated alone, and
signing out ending it at once.
