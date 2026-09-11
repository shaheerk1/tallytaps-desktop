# Location Identity And Workstation Isolation Plan

Status: core logic delivered 2026-09-11, awaiting hands-on review
Started: 2026-09-11

> **Scope rule:** The location code is the one key that separates data. It
> identifies a place where business happens *and* the catalog, customers, and
> books that belong to that place. Do not add a separate business or tenant id
> to data tables; business is a grouping label on the location list only.

## Why This Plan Exists

An audit on 2026-09-11 checked whether a workstation really separates every
transaction, in code and in the database. The result was:

- **The database model is sound for transactions.** 61 tables carry both
  `loc_code` and `mac_code` with unique origin keys, and document numbering is
  counted per location, terminal, and day.
- **Core selling works out its origin on the server side.** Billing, cash,
  refunds, and customer advances take the location from the open shift or
  session.
- **The server backup cannot collide between installations.** Records are
  unique per `(pos_node_id, entity_type, source_key)`.

It also found gaps that this plan closes:

1. `openSession` resumes any open session belonging to the user and ignores the
   workstation chosen at login, so a user can be silently returned to the
   previous workstation.
2. The main process trusts the screen. No IPC call after login checks the
   session token; permissions arrive as `actor.permissions` from the renderer,
   and expenses, lot costing, stakeholders, catalog, inventory issues, and
   accounting take `locCode`/`macCode` from the request.
3. Master data is shared by every location: `products` is unique on `sku`
   alone, and suppliers, expense categories, and settings carry no location.
   Product, customer, supplier, GRN, and settlement lists and the sales report
   read across all locations.
4. Settings are global. "Workstation settings" is one shared set, so every
   terminal prints the same header, footer, and printer choice.
5. Location codes are unique only by a manual list. The server keeps terminals
   unique per installation, not per business host.

## Decisions

These were agreed on 2026-09-11 and are the contract for this work.

1. **A location code is never reused.** A location list records every code ever
   issued. Rows are never deleted; a closed location is marked retired and its
   code stays taken.
2. **The location code separates data.** Each location has its own catalog,
   prices, handling charges, suppliers, customers, settings, and books. The
   same item may have a different price and handling charge at each location.
3. **Business is a grouping label, not a data key.** The location list carries
   a business label (for example `KST01` belongs to Khan Store). It is used for
   combined reports and for the server's monitoring view only. No data table
   gains a business id.
4. **One server host may hold several businesses of one owner.** Location codes
   are unique within a host, so the host can monitor every location and connect
   field devices without the businesses mixing.
5. **A new location starts with an empty catalog.** There is no catalog copy
   tool. Initial items, and whether any sample items ship at all, are decided
   with the first full deployment and database-initialisation release, not
   injected by application code now.
6. **The money books stay per location.** Funds, stakeholders, the journal, and
   accounting periods already work this way. Business-wide figures are the sum
   of that business's locations, found through the business label.

## Keep Codes Short

The location code is printed inside every document number, for example
`EXP-KST01-T1-20260911-000001`. A long code such as `KHANRETAILSHOP_001` makes
that 41 characters, which wraps on a 58 mm receipt printer. Keep codes short;
the location list holds the full name. Codes are stored upper case.

## Work, In Order

### 1. Login honours the chosen workstation

Delivered (`workstation.repository` `openSession`). Verified by `npm run verify:workstation-isolation` and `npm run verify:ipc-gate`.

- `openSession` resumes an open session only when it belongs to the chosen
  workstation.
- If the user has an open session elsewhere with no open cash shift, it is
  closed and the chosen workstation opens.
- If a cash shift is still open on another workstation, login is refused with a
  message naming that workstation, rather than switching silently.

Exit check: choosing workstation B while a session is open on A never lands the
user on A.

### 2. The main process decides who and where

Delivered: the preload attaches the session token to every request; `ipc-response.js` resolves the user, their database permissions, and their bound workstation (`sessions.workstation_session_id`), overwrites the identity fields, and runs the handler in `request-context`. Verified by both scripts.

- Every IPC call carries the session token. The main process resolves the user,
  their permissions from the database, and their open workstation session.
- Authorisation uses those resolved permissions, never `actor.permissions` from
  the renderer.
- Every write takes `locCode`, `macCode`, and business date from the resolved
  session. A `locCode` sent by the screen is ignored or must match.
- Reads are scoped to the session's location by default.

Exit check: a request that names another location, or claims a permission the
user does not have, is refused.

### 3. The location list

Delivered (migration 104, Workstations screen). Database triggers refuse deleting or renaming a location code.

- A `locations` table: code (primary key, never reused), business label, name,
  status (`active` or `retired`), created date.
- `pos_workstations.location_code` references it and is widened from 30 to 50
  characters to match every transaction table.
- Existing codes (`MAIN`, `DDEC-A-2-6`) are added to the list under a business.

Exit check: a retired code cannot be given to a new workstation.

### 4. The server enforces codes per host

Delivered in `server-app` (`007_host_location_ownership.sql`, `claimLocations`), enforced per location code rather than per terminal: one installation owns a location code within a host. **Not applied to the live server database**; verified against a throwaway local database with `db-checks/host-location-ownership.js`.

- Terminal codes become unique per host, not per installation, so a second
  machine cannot register a location code already used under that host.

Exit check: a second installation claiming `KST01` under the same host is
refused at registration.

### 5. Master data moves to per location

Delivered (migration 105). Products and suppliers belong to one location; expense categories, supplier charge types, and settings are a shared set a location extends or overrides. Database triggers refuse another location's item, supplier, customer, or category on a document.

- `products` gains `loc_code`; `sku` becomes unique per location.
- Suppliers, supply agreements, supplier charge types, expense categories, and
  settings gain `loc_code`.
- Customers already record the location they were created at; their lists and
  searches filter by it.
- Users, roles, and the chart of accounts stay shared.
- The existing 190 products are assigned to `DDEC-A-2-6`, the only location
  that has ever used any of them. Nothing is copied.

Exit check: an item, supplier, customer, or setting created at one location is
not visible at another.

## Found While Building

- **A fresh install fails at migration 018.** It inserts sample products into
  `category`, which migration 025 adds later. Existing databases work because
  they grew through earlier schema versions. This belongs to the deployment
  release.
- **`server-app/database/003_pos_archive.sql` cannot be applied on MySQL 8.**
  Its unique key `(pos_node_id, entity_type, source_key VARCHAR(700))` is 3,156
  bytes in utf8mb4, over InnoDB's 3,072-byte limit.
- **Fixed:** the sales report's "Every sales line" grouping produced
  `ORDER BY 0`, which MySQL refuses, so that option always failed.
- Settings for receipts, billing, and printing now save to the signed-in
  location. The Settings screen does not yet say which location it is editing.
- **Bills printed the shared address after a location saved its own**
  (reported 2026-09-11, fixed). `settings.receipt.get` needed no sign-in, so it
  ran with no location and read only the shared rows, while the Settings screen
  (signed in) had saved the location's row. A second source of confusion: old
  `workstation.store_address_1/2` and `workstation.store_phone` copies filled in
  whenever the General value was empty. Fixed by:
  - making the receipt channel signed-in;
  - resolving the receipt in one place (`packages/core/printing/receipt-settings.js`),
    which both the bill and the PDF use, with no cross-group fallback;
  - migration 107, which moved any text the bill was falling back to into
    General (same scope) and deleted the old copies and the unused
    `workstation.default_printer`.

  To stop it recurring, a channel that needs no sign-in now runs in an
  anonymous request context, and `settings.service.js` refuses it the
  location-scoped codes instead of quietly answering with the shared values.
  `catalog.products.get` also became signed-in.

## Open Items For The Deployment Release

- Migration `018_seed_sample_products` inserts sample items (`ITEM001` onward)
  on every fresh install, which conflicts with decision 5. It has already run on
  existing databases. Decide at the deployment release whether fresh installs
  keep, drop, or replace it.
- Expense categories and the chart of accounts are seeded by migrations 089 and
  092. Once categories become per location, decide how a new location receives
  its starting categories.
