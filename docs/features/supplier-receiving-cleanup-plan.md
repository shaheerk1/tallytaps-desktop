# Supplier Receiving Cleanup

Status: delivered 2026-09-16
Applies to: `desktop-app` (Supplier Receiving)

## Why This Exists

Supplier Receiving had five tabs. Two were in the way:

- **Supplier settlement** was never used in the field. Supplier Sales Statements
  is where suppliers are actually worked out.
- **Setup** forced a supplier (and optionally an agreement with a commission) to
  be created before goods could be received. Commission already lives on the
  Supplier Sales Statement.

The page now has three tabs: Receive goods, Supplier sales statements, Stock
control.

## Receiving A GRN

| Field | Now |
| --- | --- |
| Supplier | One box: pick a known supplier from the list or type. Typed text matching a supplier's code or name (any case) uses that supplier; anything else is added as a new supplier with just that name when the GRN is saved. |
| Agreement | Always **Owned purchase** or **Consignment**, for every supplier. No commission. |
| Business date, Vehicle / truck | Unchanged. |

## Same Tables, Unused Parts Left Empty

No migration.

- A typed supplier is a normal `suppliers` row: `name` filled, `supplier_code`,
  phone and address empty, `metadata.createdFrom = goods_receipt`. Its lots are
  coded with the `SUP` prefix, as before for suppliers with no code.
- Ownership is kept on the GRN in `goods_receipts.metadata.ownershipModel`.
  `agreement_id` stays empty for new GRNs.
- Lots get that ownership, and `terms_snapshot.commissionRate` is 0. Consignment
  lots therefore accrue the full sale value to the supplier ledger; the real
  commission is set on the Supplier Sales Statement.
- A correction copies the original GRN's ownership.
- An older GRN that names an agreement still reads its ownership from that
  agreement when it has none of its own, and an inactive agreement no longer
  blocks finalizing.

## What Was Removed

- The Settlement and Setup tabs and their code on the screen.
- IPC channels `supply.suppliers.account`, `supply.settlements.create/approve/pay/list/get`,
  `supply.charges.listTypes/add`, `supply.agreements.create`, and their preload
  methods.

Kept on purpose: the settlement, payment and charge repository functions and
their tables. Sales still write the supplier ledger, issued-cheque reversal still
reads supplier payments, and the old records stay intact. `supply.agreements.list`
stays because the statement workspace still pre-fills a commission from an old
agreement where one exists.

## Verify

`npm run verify:grn-supplier` — through the real IPC channel: new typed supplier,
reuse by code or name, ownership on the GRN with no commission, corrections keep
ownership, old inactive agreements do not block, retired channels are gone.

## Follow-up (2026-09-18): removing unused GRNs, typed statement suppliers

- **Remove GRN** (migration 121, status `removed`): on a finalized GRN's view.
  Allowed only when nothing has used it: no stock movement other than the
  receipt (sale, send-out, count, adjustment, issue), no live lot expense or
  expense allocation, no statement that is not void, no settlement, no active
  correction. The detail tells the screen why not (`removalBlocker`).
  Removing posts a `receipt_removed` stock movement per lot (document type
  `grn_removal`, document no = GRN id), empties the lots (freeing lot codes),
  reverses owned-purchase amounts due with `return_credit` entries, and keeps
  the GRN with who, when and why. Removed GRNs leave every list and picker.
  Drafts are still cancelled, not removed.
- **Statement supplier** is type-or-pick, as on the GRN. A new name is added
  (`supply.pattiyals.suppliers.resolve`) when the statement is saved, when
  Enter is pressed, or before correcting a sale line's supplier.
- **Register totals**: the statement list returns totals over every statement
  the filters match (subtotal, commission, credits/deductions, BL / Net, and
  finalized-only net); voided statements are counted but their money is left out.
- Verify: `npm run verify:grn-removal`.
