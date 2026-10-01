# The field notebook

Status: delivered 2026-09-30, laid out as a notes app 2026-10-01 (server schema 008; no POS migration)
Applies to: `mobile-app` (the writing), `server-app` (carrying and ticking off),
`desktop-app` (Field Transaction Inbox)

## Why it changed

The phone opened with four buttons — cash, card, stock, note — and each wanted a
category chosen before a word could be written. In real use the owner reads the
monitor all day and almost never records through those four doors. What a person
in the field actually needs is a notebook: write what happened, attach what
proves it, and let the shop see it.

## What the phone does now

Home has **two** things: **Write a note** and **New bill**.

A note is one page. The words are the only thing required. Underneath, details
are **tapped on when they matter**:

| Detail | What it holds |
| --- | --- |
| Money | how much, in or out, cash or card |
| Goods | an item **from the connected POS catalog**, with its quantity — and both quantities when the POS keeps that item in two measures |
| Who | any name, remembered after first use |
| Tags | the writer's own words, most used first |

Typing `@Kamal` or `#credit` in the note makes those marks by itself; the words
stay in the note as written, and any mark can be taken off again.

A note can say **somebody has to do something**. It then sits at the top of the
notebook under **To do** until a counter ticks it off, and it comes back marked
*Seen at the shop*, with who saw to it.

Everything else the old page had is kept: camera, gallery, voice notes, and the
draft that survives leaving the screen (now with the marks in it too).

## How it fits what already existed

The person never picks a category, but the record still needs one on the wire,
so the phone fills it in: money makes it **cash** or **card**, goods make it
**stock**, anything else is a **note**. The POS inbox's filters and money totals
therefore keep working, and no record type had to change.

The marks travel in the record's own payload as `details`
(`who`, `tags`, `needsDoing`, `kind`), which the server validates and the POS
inbox shows under each note.

Ticking off is new on the server (`record_followups`, schema 008): the POS posts
it when a record is resolved, and the phone reads it back for its own notes. Both
sides degrade quietly on a server without that table yet, so the inbox cannot
break on the way there.

## Verify

- `server-app`: `npm test` — note details accepted and bounded, and the archive
  and record endpoints as before.
- `mobile-app`: `flutter test` — the note page, its typing shortcuts, and the
  home screen with its two buttons.


## The app as a notebook (2026-10-01)

The app opens on the notes themselves. Three places sit across the top:
**Notes**, **Business** (the monitor), and **Owed** (what customers owe and what
the shop owes its suppliers). The last two appear only when the host has granted
monitor access.

- **Notes** is the home: a search box, the notes newest first under day
  headings, and a floating button in the corner. Tap it for a new note; **hold
  it for a new bill**. The old received/paid summary is gone.
- **A note is a row from the first word.** It saves itself as it is typed and
  when the page is left, so there are as many unfinished notes as the person
  wants, each shown in the list marked *Unfinished*. Opening one picks it up
  where it was left; the old one-draft-per-category store is retired.
- **Done**, in the corner of the note page, is the only thing that sends it. It
  asks first, because a sent note cannot be changed: there is no way to change
  one that has already gone. Only finished notes sync; drafts never leave the
  phone.
- A note can also be **thrown away** from the same corner.
- Sent notes and mobile bills stay reachable through the **Sent / waiting to
  sync** badge in the header, which opens the older full list.

Data: `actions.status` is `draft` or `final` (tally.db v7). `unsynced` means
finished and not yet sent, so the sync queue never sees a draft.
