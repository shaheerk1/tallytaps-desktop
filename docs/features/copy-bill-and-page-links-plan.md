# Copying A Bill, And Opening One Screen From Another

Status: delivered 2026-09-15
Applies to: `desktop-app` (Billing, Invoice Archive, Customer Accounts)

## Why This Exists

Two requests with the same shape: one screen should open another already
pointed at the right thing.

1. **Copy a finished bill into a new one.** The same bill again with some values
   changed — a second copy at another rate, a repeat order, a bill re-entered
   correctly before the wrong one is refunded. Refunds are solid, so a copy that
   turns out to be unwanted can be undone in the ordinary way.
2. **From a customer's account, open the bill.** Clicking an outstanding bill
   should open the invoice archive with its filters already set to that bill.

Nothing in the app opened one screen from another with details before, so this
adds a small shared mechanism rather than two one-off hacks.

## Page Links

`apps/desktop/angular/src/app/services/page-links.service.ts`

- A link is a small typed request carried as query parameters, so it survives a
  reload and the back button.
- The sender calls an `open...` method (`openInvoiceArchive`, `openBillingCopy`).
- The receiver calls `onLink(route, read...Link, apply)` in `ngOnInit`, which
  applies the link it opened with and any that arrive while it stays open, then
  calls `consume(route)` so a reload never repeats the action.
- Parameter names live only in that file.

To add a link: add a `...Link` type and its names to `PARAMS`, an `open...`
method, a `read...Link` function, and `onLink` in the receiving screen.

## Copy To New Bill

**Where:** Invoice Archive → an open bill → **Copy to new bill**; or Billing →
**Copy a Bill** → search by invoice or receipt number. Both land in Billing,
which already checks rates, customer, credit and payment.

**How it works** (`billingEngineService.copyInvoiceToBill`, channel
`billing.invoices.copyToBill`, permission `billing.create`):

1. The source must be a finalized bill at the signed-in location.
2. A new receipt number is allocated and every line is added through the same
   path a cashier's typed line takes (`addLineToBill`), so the item must still be
   active here and a rate must still pass that item's price rules today.
3. Lines that fail are left out and named on screen; if every line fails, the
   new receipt is abandoned and the request is refused.
4. Payments are never copied. Nothing is posted — no invoice, stock allocation,
   supplier payable, drawer or customer entry — until the new bill is finalized.
5. The new lines carry `metadata.copiedFrom`; finalize writes it onto the new
   invoice, and the archive shows a **Copy of …** tag that opens the source.
6. A bill already being worked on stays in Pending Bills, as a recall leaves it.

Also tightened on the way: `addLineToBill` now refuses an item that has been
switched off. Looked up by id, an inactive item was previously still accepted.

## Customer Accounts → Invoice Archive

Outstanding bills, and account-activity lines that belong to a bill, are now
clickable. They open the archive with location, counter, date and invoice number
set to find that bill, open its detail, and include fully returned bills if that
is what it takes to show it.

## Verify

- `npm run verify:bill-copy` — 8 checks through the real IPC channel on a
  throwaway copy of the database.
- `tools/e2e-verify/lib/ipc-harness.js` is the shared way to boot the real app
  for such checks; `verify:ipc-gate` now uses it too. Prefer it for any feature
  with a new channel: a handler or preload bridge that was never wired shows up
  as a missing channel instead of passing unnoticed.
