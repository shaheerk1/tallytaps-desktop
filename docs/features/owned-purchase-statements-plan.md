# Owned Purchase Statements

Status: delivered 2026-09-16 (migration 115)
Applies to: `desktop-app` (Supplier Receiving → Supplier sales statements)

## Why This Exists

The Supplier Sales Statement page builds accurate consignment statements from
sale lines, manual rows, GRN comparison, credits and deductions. Nothing in it is
removed. Three things were missing:

1. Searching every sale needed a supplier chosen first.
2. Goods bought outright (owned purchase) had no statement: the supplier is paid
   for what was received, at a price, not for what was sold.
3. Credit and deduction labels were retyped each time, so the same cost appeared
   under many spellings.

## The Page

**Create Supplier Sales Statement** now opens with two tabs.

| Consignment (default) | Owned purchase |
| --- | --- |
| Exactly as before: sale lines, partial allocation, manual and pasted rows, optional GRN comparison, commission. | 1. Supplier and GRN period · 2. Select GRNs · 3. GRN items and prices · 4. Supplier credits and deductions · 5. Grouped statement preview |

Each tab keeps its own selections while a new statement is being built, so moving
between them loses nothing; only the open tab is saved. A saved statement keeps
its type.

### Every sale, before a supplier

A new statement opens on **Search all sales** and lists every sale line in the
date range with no supplier chosen. **Suggested sales** still needs a supplier.
Lines can be ticked before a supplier is chosen, but the statement is saved only
with a supplier, and "Correct supplier" waits for one.

### Owned purchase

- **All of the supplier's GRNs** are listed (owner's choice), each marked Owned
  or Consignment. Ticking a consignment GRN shows a warning, because it is
  normally settled on a consignment statement.
- **Each line starts from its GRN**: Unit Count, Measured Qty and unit cost. The
  price basis follows the GRN cost: per measured quantity when the item was
  measured, otherwise per unit.
- **Any change from the GRN needs a reason**: quantity, measured qty, rate (when
  the GRN had a cost) or line total. The GRN values are stored beside the charged
  ones, so the difference is always visible.
- **No commission.** Payable = purchase subtotal + credits − deductions.
- **A GRN line is paid once.** A draft may overlap another (with a warning). A
  line on a reviewed or finalized purchase statement is refused on save and on
  review, until that statement is reopened or voided. The GRN list shows which
  statement paid it.
- Printed, PDF, Excel and Word copies are titled **Supplier Purchase Statement**.

### Remembered labels

The credit/deduction label box lists labels used before at this location, for the
chosen type only, most used first. Typing a known label in another case saves it
with the spelling already in use (on screen and on the server), so reports can
group by label and type. No new table: labels are read from
`supplier_sale_statement_adjustments`, which already stores the type.

## Data

Migration 115:

- `supplier_sale_statements.statement_type` (`consignment` default, `owned_purchase`)
  and `build_mode` value `purchase`.
- `supplier_sale_statement_purchase_lines`: GRN, GRN line, item, basis, GRN
  quantity/measured/cost, charged quantity/measured/rate/amount, reason.
- An index on adjustments by location, type and label.

Statements remain evaluation documents. Neither type posts to the supplier ledger.

New IPC channel: `supply.pattiyals.adjustmentLabels`.

## Verify

`npm run verify:owned-purchase`: 7 checks through the real IPC channel.
