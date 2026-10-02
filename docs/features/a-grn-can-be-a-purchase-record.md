# A GRN is either a stock receipt or a purchase record

Status: delivered 2026-10-02 (migration 127)
Applies to: `desktop-app` (Supply & Receiving, lot costing, the derived journal)

One shop runs on perishables and never counts stock: damage, repacks and loose
sales move the real figures hour by hour, so a stock number kept to three
decimals is precise and wrong by the afternoon. They stopped writing GRNs
altogether — and lost the part they actually need every day, which is the money.
What they buy, at what price, from whom, and what is still owed, because they
settle several supplier statements daily.

So a GRN now says which of two things it is.

| | Stock receipt | Purchase record |
|---|---|---|
| The lot | holds what arrived, and can be sold from | is born empty, and can never be sold from |
| Stock ledger | a `receipt` movement is posted | nothing is posted |
| Supplier is owed | yes | yes, exactly the same |
| Supplier statements | as before | as before |
| Lot expenses and landed cost | as before | as before |
| The cost sits in | stock value (1200) until the goods sell | goods cost (5000) straight away |

A stock receipt is what every GRN was before this, and is still the default.

## Why this is a method, not a bypass

A purchase record is **periodic inventory**; a stock receipt is **perpetual**.
Both are proper ways to keep books. Perpetual treats goods as an asset and
releases their cost as they sell; periodic charges purchases as they are bought
and measures profit over a period. A perishables shop is the case periodic was
made for.

What makes it honest rather than a hole:

- **The books move too, not just the stock.** `supplierObligationPosting` and
  `allocationPosting` charge a purchase record to goods cost (5000) instead of
  holding it as stock value (1200). Without that, 1200 would grow for ever and
  5000 would never be charged, because nothing sells out of those lots — the
  ledger would quietly become fiction. With it, the journal balances and the
  profit and loss reads honestly.
- **Consignment is refused.** A consignment supplier is paid from what sells out
  of their lot, which is read off sales allocated to it. No stock, no sales, no
  money owed — silently. So a consignment delivery must be a stock receipt, and
  the system says so rather than allowing it.
- **The kind is written on the document and never changes.** `stock_mode` lives
  on `goods_receipts`, so a GRN read back in two years says how it was posted. A
  correction keeps the kind of the GRN it corrects. To change it, remove the GRN
  and enter it again, which is already a reversal (migration 121).
- **Nothing is hidden.** The lot records what arrived, carries the landed cost,
  and is marked `stock_tracked = 0`. The audit trail is complete; what is absent
  from the data is exactly what the shop has declared it is not keeping.

## How it stays out of the way at the counter

No new rule was needed to keep a purchase record out of selling, because the
lot design already had one: `active_lot_tag` is a generated column that is NULL
once a lot is empty. A lot born empty therefore has no code a cashier can type,
cannot collide with a live code, and is skipped by the allocator, which only
looks at lots with something remaining.

## What the shop gives up

No cost of goods per sale, so no margin per item or per lot on those goods —
profit becomes a period figure, purchases against sales. Lot *costing* still
works (what a load cost to land, lorry hire and all); lot *profitability* does
not, because sales are not tied to those lots. Stock on hand reads zero for
them, which is correct, and the lot list labels them rather than leaving them
looking like lots that sold out.

## Still open

A shop in this mode still raises an `inventory_allocation_exceptions` row for
every sale line that finds no lot, and those pile up in the Supply screen. That
is unchanged by this work — it was already happening while they ran without
GRNs at all — but it is worth switching off for a shop that has declared it
keeps no stock.

Verify: `npm run verify:purchase-record` — eight invariants, including that the
journal balances, a sale takes nothing from it, a lot expense still attaches, an
owned purchase statement still settles it, and a stock receipt beside it behaves
exactly as before.
