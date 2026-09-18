# Lot Codes At The Counter

Status: delivered 2026-09-16
Applies to: `desktop-app` (Receiving, Billing, supplier settlements)

## Why This Exists

After months in the field, cashiers do not use the bill's "Supplier" field as a
supplier code. They use it as a **supply code**: which load this sale came from.
The screen meanwhile chose the lot by FIFO or by what was last used, so what the
cashier typed and what the stock ledger did could disagree, and a wrong code was
absorbed silently by the oldest lot.

So the field becomes what it is already used as, and the keyboard alone decides
the lot.

## The Two Identities Of A Lot

| | Purpose | Changes? |
| --- | --- | --- |
| `lot_code` (`SS-DDEC-A-2-6-20260824-3-1`) | The lot's permanent identity. Allocations, costs, statements and every bill line point at the lot itself. | Never |
| `lot_tag` (`KAR1`, `BO1102`) | The short handle typed at the counter, and nothing else. | Anyone who can receive goods |

Because a bill line stores the lot, renaming a tag can never orphan old lines.

- **Suggested at receiving**: the item's own code plus the next free number
  (`KAR` → `KAR1`, `KAR2`). The receiver can rename it to anything memorable.
- **Unique among lots that still hold stock at that location.** A sold-out lot
  releases its tag, so short codes are reusable on later days. Enforced by the
  generated column `active_lot_tag`, which is NULL once the lot is empty
  (migration 113).

## What The Counter Does Now

1. The **Supply code** field takes a lot tag. Typing one names that lot; the
   Stock lot priority control follows the typed code rather than FIFO.
2. **A code matching no open lot leaves the line with no lot** — even when the
   item has open lots. Such a line takes no stock at finalize and is recorded as
   an unmatched allocation, exactly like an item that never had a GRN. That is
   the "not sure" tracking: the sale still completes, and stock is not quietly
   taken from the wrong load.
3. **Choosing a lot with the mouse writes its tag into the field**, so the two
   always agree, and the list has a **No lot** option for selling without naming
   one even when lots exist.
4. **The code on a line already added is editable**, like rate and quantity.
   Saving it moves that line onto the lot with that tag, or releases it to no
   lot. Stock is still taken at finalize, as before.

Everything is resolved on the server (`resolveLineAllocation` in
billing-engine.service.js), so the screen cannot name a lot it should not have.
A matched lot still covers the line first and any remainder continues through
FIFO, which is unchanged.

## Remembered Codes, And Shops That Skip The Field

Added 2026-09-16 (migration 114).

**What is remembered is the text, not a decision.** When a line is added, the
code in its Supply code field is remembered for that item, for that cashier, for
that business day (`supply_code_memory`). A row from an earlier day is simply not
read, so memory ends when the day does.

When the cashier moves on to an item **without typing a code for this line**:

1. today's remembered code for the item is filled in — it names its lot, or
   leaves the line with no lot, exactly as if it had been typed;
2. otherwise a code carried over from the previous line is kept, if it is a lot
   of this item;
3. otherwise the oldest open lot is used (FIFO) and its code written into the
   field.

A code typed, or a lot picked from the list, for this line always wins and is
what gets remembered. "Return this product to automatic FIFO" now forgets the
remembered code for that item.

**Settings → Billing → "Ask for a supply code on every bill line"** (per
location, on by default). Turned off:

- Billing hides the Supply code field; Stock lot priority still works, with the
  same remembered and FIFO rules.
- A line with a lot is saved with that lot's code. A line with nothing is saved
  with the location's **receipt tagline** (`A-2-6`) as its supply code, so every
  line still carries a code and reports see the same shape of data.
- The tagline code is applied on the server, is **never matched against lot
  codes** (a lot that happens to be named the same is not picked), and is
  **never remembered**.

The tagline was chosen by the owner over a separate setting. Because the tagline
is receipt text, changing it later changes the code saved on future lines only;
older lines keep the code they were saved with.

## The Code Fills In The Item

Added 2026-09-18. A supply code that names an open lot also names its item, so
pressing **Enter** (or Tab) in the Supply code field fills the **Item** field
with that lot's item code and leaves it focused with the text selected:

- **Enter** confirms the item, exactly as if its code had been typed. The lot the
  code names is then the line's lot.
- **Typing** replaces the selected text, so a different item needs no erasing.
- Nothing is filled over an item the cashier already typed or chose, or for a
  code that names no open lot (the field just moves on, as before).

The filled code counts as typed for that line, so today's remembered code for
the item does not replace it. The lookup is `billing.supplyCodes.lot`, which uses
the counter's own location and business date.

## Supplier Settlements

A sale line used to be credited to a supplier by matching the typed code against
`suppliers.supplier_code`. With lot codes in that field, that match would fail,
so settlement candidates now read the supplier from **the lot the line actually
consumed** (`lot_sale_allocations` → `inventory_lots` → supplier), falling back
to a manual attribution first and the typed code last. A line split across two
suppliers' lots keeps the old behaviour.

## Moving An Existing Shop Over

- Every existing lot was given a tag by migration 113 from its item code
  (`test1` → `TEST11`, `TEST12`, …). Rename them on **Receiving → Lot codes** to
  whatever the staff will remember.
- Old habits type supplier codes (`SS`, `JJ`). Those no longer match a lot, so
  such lines will record as unmatched until staff use the new codes. Watch the
  unmatched allocations list for the first days.

## Verify

`npm run verify:lot-tag` — 13 checks through the real IPC channel: tag
suggestion, typing a code, an unmatched code taking no stock, a named line
consuming its lot, editing a line's code, renaming, tag reuse, supplier credit following the lot, the day-long memory,
the optional code with its tagline default, and a code naming its item (14 checks).
