# Supply work on the phone

Status: delivered 2026-09-28 (migration 125)
Applies to: `desktop-app` (sync), `server-app` (monitor reads), `mobile-app` (Supply tab)

The Business Monitor could show sales, bills, cash and stock, but nothing about
the supply side. It now has a **Supply** tab with four views.

## What travels to the server

Migration 125 gives these tables the sync stamp they need, and the cloud sync
carries them: `suppliers`, `supplier_sale_statements` with their allocations,
manual lines, purchase lines and adjustments, and `supplier_account_entries`.
Delivery notes now travel as **drafts** too (anything but a cancelled one).

Supplier names were being looked up among the parties, where they never were,
so every supplier read as unnamed. They are read from `suppliers` now.

## The four views

- **Deliveries** — every delivery note over the chosen period, filtered by
  *All / Posted / Being written*, with the supplier, the agreement, the vehicle,
  the line count and what the goods are worth. Opening one shows every line in
  both measures with its cost and value, in a table that pinches to zoom.
- **On floor** — the lots still holding stock, grouped by item, each showing the
  lot code, the supplier, whether it was bought or is on consignment, how old it
  is, what came in and what is left. Search by item, lot code or supplier;
  emptied lots can be included. Not tied to the date range: what is on the floor
  is on the floor.
- **Statements** — supplier statements filtered by *All / Draft / Reviewed /
  Finalized*. Opening one shows the subtotal, commission, packaging and wage,
  credits and deductions and the net payable, then every line behind it in a
  zoomable table, and each credit or deduction on its own.
- **Owed** — what each supplier is owed: finalized statements less what has been
  paid, exactly as the desktop builds it, and not tied to the dates. Opening a
  supplier gives the account sheet, oldest first, with a running balance, in a
  zoomable table. A reversed entry stays on the sheet, struck through.

## The table

`monitor_table.dart` is a desktop-style table for a phone: it scrolls both ways,
pinches to zoom with buttons for smaller / bigger / fit, keeps its head above the
rows, right-aligns numbers with tabular figures, and ends on a totals line.

## Verify

- `server-app`: `node --test test/monitor-supply.test.js` — seven checks against
  a throwaway archive built on the local MySQL.
- `mobile-app`: `flutter test test/monitor_supply_test.dart` — the models.
- `desktop-app`: `npm run verify:cloud-archive` — every stream still matches its
  table.
