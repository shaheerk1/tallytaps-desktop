# A POS that runs on a tablet

Status: planned 2026-10-02 — not started
Applies to: a new fourth project in `E:\MY_MAIN_APPS\Tally`, alongside
`desktop-app`, `server-app` and `mobile-app`

A shop with no desktop should be able to run on an Android tablet: billing,
returns, credit customers, cash, deliveries, expenses and reports, all of it
offline, printing to a Bluetooth 80mm thermal printer, and syncing to the host
so the Business Monitor shows that shop exactly as it shows every other
counter.

This is a separate app. The notebook app (`mobile-app`) stays small and stays
in the field; its quick billing keeps working and can be retired whenever the
real thing has replaced it — or kept, since a field person with no counter
still has a use for it.

## What was decided

- **Android only.** Tablets first, phones supported. No iOS.
- **A tablet is its own shop**, with its own `loc_code`, its own items, stock,
  customers and suppliers. It is never a second counter sharing a desktop's
  stock: that could not be offline.
- **One device is one workstation.** No workstation management, no switching.
- **Logins, but no permissions.** Users exist so the till knows who is on it
  and bills carry a name. No roles, no permission levels, anywhere.
- **Master data is pulled once at setup** from a chosen POS node, then owned
  locally. After that nothing flows down.
- **Flutter for the screens, the existing Node core for the rules, SQLite for
  the data.**

## Why the rules stay in Node

The sync decides this. Every archive event is a raw table row —
`cloud-sync.repository.js` lists some sixty streams of the form
`{ entity: 'invoice', table: 'invoices' }` — and the server stores the row and
reads it back **by column name**. For the monitor to show a tablet the way it
shows a counter, the tablet's tables must be identical to the desktop's in
name and in column, not merely similar.

Given that, reimplementing the ledger in Dart buys nothing and costs a great
deal:

- `packages/core` is 41 files and 6,726 lines, and **38 of them never touch a
  database**. The posting rules, refunds per measure, lot costing, supplier
  statements, cash shifts and equity all run as they are.
- Of 888 SQL statements in the repositories, the MySQL-only parts are 143
  `FOR UPDATE` (SQLite is single-writer, so they go), 57 date functions, 18
  JSON calls, 14 `ON DUPLICATE KEY` and 5 `GROUP_CONCAT`. Roughly 250
  statements need a hand, not 888.
- All 289 permission checks sit in the IPC registry and none in the core, so
  dropping roles is a matter of not calling the gate.
- The verifiers in `tools/e2e-verify` boot the real container and the real
  channels. Pointed at a SQLite build they become the proof that the tablet
  and the desktop agree.

A Dart rewrite would mean two ledgers in two languages, and every rule we fix
landing twice, for as long as both exist. That is the thing most likely to
sink this.

The runtime is [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile),
now on Node 24 for Android with `node:sqlite` built in, so nothing native has
to be cross-compiled. The Flutter side talks to it over a local channel that
carries the same request and response shape as `preload.js` does today.

**If the spike fails**, the fallback is not a Dart rewrite. It is the tablet as
a LAN terminal of a host PC — which gives up offline billing, and should be
chosen with eyes open rather than drifted into.

## The keystone: a generated schema

The SQLite schema must not be written by hand, and must not be allowed to
drift as the desktop keeps growing. A generator reads
`packages/database/migrations/core/*.sql` and emits:

1. **the SQLite baseline** — 126 migrations squashed into one schema, with
   `ENUM` (122 columns) becoming `TEXT` with a `CHECK`, the 11 triggers
   rewritten, and the 2 generated columns handled;
2. **a money-column map** — the 202 `DECIMAL(14,2)` columns.

Money is the one place a port corrupts accounts quietly. SQLite has no exact
decimal, so amounts are stored as **integer cents**; the map is what scales
them back to rupees at the one boundary where it matters — the sync payload —
so the archive carries `123.45` from a tablet exactly as it does from a
desktop. Get this wrong and the monitor shows Rs 12,345 for a Rs 123.45 bill.

From the baseline the tablet keeps its own migration line. The generator is
re-run whenever the desktop schema moves, and a mismatch between the two is a
build failure, not a surprise in the field.

## Touch, and not-touch

A setting with two modes:

- **Touch** — a number pad is always on screen on any page with number fields,
  the way the bill finalize page already does it (`.pm-numpad` in the desktop
  billing screen, `number_pad.dart` on the phone). The system keyboard comes up
  only for text fields.
- **Keyboard** — no number pad at all, and the Enter-walks-the-fields flow the
  desktop has on billing, cash and GRN entry.

One numeric-field widget honours the setting everywhere, so no screen decides
this for itself.

## Scope

Ported: items, billing and returns, customers and credit, cash shift and
movements, deliveries and suppliers, supplier statements and accounts,
expenses and funds, reports, users (login only), settings, sync setup.

Not ported: locations and workstation management, roles and permissions,
anything that assumes more than one counter.

The screens follow the desktop so the two feel like one system, but a tablet is
not a mouse — where a touch layout is plainly better, it wins.

## Printing

80mm Bluetooth ESC/POS. The receipt is already built as a `PrintDocument` by
`packages/core/printing`, so the content and the layout settings come across;
only the rendering is new.

## Phases

1. **Spike, as a go/no-go.** The real core and a handful of repositories on
   SQLite under nodejs-mobile, with existing verifiers run against it. Small,
   and it answers the whole question before anything is built on it.
2. The schema generator, the SQLite baseline, and money as integer cents.
3. Setup: the login, the one workstation, and pulling the catalogue once from
   a POS node (the server already serves it at `/mobile/catalogs/:nodeId`;
   note the present 1000-product cloud limit).
4. Billing, returns, cash — a real counter, with the printer.
5. Suppliers and deliveries, expenses, reports.
6. Sync, and the monitor showing the tablet as a shop of its own.

## Known risks

- **Money**, as above. First, not last.
- **Backup.** A tablet holding a shop's only ledger is one dropped device from
  losing the business. Sync cannot be the last phase in practice, even though
  it is listed last — a local export has to exist well before then.
- **nodejs-mobile** is a narrower path than Flutter alone: a bigger app, a
  bridge to debug, and a dependency whose health we do not control.
- **Two schemas** that must stay identical for every synced table. The
  generator is what keeps them honest; without it this fails within months.
