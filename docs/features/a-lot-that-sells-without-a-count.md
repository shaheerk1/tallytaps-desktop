# A lot that sells before anybody counted it

Status: delivered 2026-10-15 (migration 128)
Applies to: `desktop-app` (Supply & Receiving, billing, Stock control → Lot codes)

Goods arrive on consignment and the shop starts selling the same morning. How
many bags came, and what they weighed, is not known and sometimes never will be.
What is known is the lot they are being sold under.

A delivery note can now be written with **no quantities at all**. Its lot sells
on its code until somebody says the load is finished.

## The three kinds a delivery note can be

`goods_receipts.stock_mode` now has three values:

| | Lot holds | Sold by | Finished by |
|---|---|---|---|
| **Stock receipt** | what arrived | any sale, oldest lot first | selling out |
| **Purchase record** | nothing | nothing | — |
| **No quantities** | nothing to count | naming its code | somebody finishing it |

Each belongs to one side of the ownership question, and the form refuses the
other: a **purchase record** is money owed for goods, so it is an owned
purchase; **no quantities** can only be consignment, because an owned purchase
is owed for what arrived and so has to be counted.

## The three things that follow from having no balance

1. **It keeps its code until it is closed.** `active_lot_tag` was "the code
   while something is left"; it is now "while something is left, **or** while an
   uncounted lot has not been finished". The generated column reads
   `quantity_known` before it reads the balance.
2. **It is never picked by itself.** A sale reaches it only by naming its code.
   This is the one that would have hurt: a lot that never empties, left in the
   ordinary queue, would swallow every sale of that item ahead of the stock that
   can be counted, and the counted lots would stop depleting.
3. **It keeps no stock**, the same way a purchase record keeps none. There is no
   number to add and none to take away, so it writes nothing to the stock ledger
   and nothing there can go negative.

What sold out of it is read from its allocations, which is also where the
consignment accrual comes from — the supplier is owed on **sale value**, never
on quantity, so that side needed no changes at all.

## Finishing one

**Stock control → Lot codes** shows an uncounted lot with what it has sold so
far in place of a balance, and a **Finish lot** button.

Finishing writes down what it sold as what it received. From that moment it
reads as an ordinary lot that sold out: lot costing, the supplier's statement
and the books all work on it without knowing it was ever open, and its code goes
free for the next load at the same moment, which is what finishing means.

## Entering one

The GRN form asks for the items and nothing else: quantity, measure, ratio and
cost are switched off, and **Finalize** waits only for each line to have its
item chosen. The backend writes nothing down as received either — a number typed
before the kind was switched, and then left behind, would be read later as a
count somebody actually took.

## What such a lot shows, where a balance would be

An uncounted lot has no balance, so showing one reads as zero stock and tells
nobody anything. In its place it shows **what it has been billed for** — on the
dashboard, in the lot picker on a bill line, and on the lot codes page. A
counted lot still shows its balance exactly as before; the two are told apart by
`quantity_known`, so no existing lot changed behaviour.

The lot picker shows it in both of its states: in the open list, and on the
closed control where the chosen lot is summarised. Reading "Rem 0/0" there is
what a cashier sees for most of a bill, so the closed control has to say the
same thing as the list it came from.

## The other two ways goods leave it

Billing is not the only one. A load can leave on another lorry, and goods can
be wasted, damaged or sent back to the supplier. Both are open to a lot nobody
counted, and both work the same way as a sale does there: the movement is
recorded, no balance is run down (there is none), and nothing is posted to the
stock ledger (it keeps none). Posting either would be the very thing that
drives the ledger negative.

So an uncounted lot accepts only *outflows*. An adjustment that would add goods
back is refused: there is no balance to add to, and a bag that is still there
is not a fact anybody counted.

**Finishing it therefore counts all three.** What such a lot received is the
whole of what left it -- billed, sent out, and lost -- because that is the only
number anybody can honestly write down for a load nobody counted. A lot that
sold 15, sent out 3 and wasted 2 is recorded as having received 20.

A counted lot is unchanged by any of this: an adjustment moves its balance and
its stock movement together, as it always did.

## What bills still on the counter have booked

Every lot, counted or not, also shows what bills **being written** have booked
against it: "40 BAG · 820 KILO on hold", in all three of the same places.

A bill line lives in `invoice_items` from the moment it is typed and carries no
invoice until the bill is taken, so a line with no invoice is what "still on the
counter" means. Only lines that **name a lot** are counted: a held line naming
none goes to the oldest stock when the bill is finished, so it is not booked
against anything yet and must not be shown as if it were.

Nothing is reserved by this. It is a figure to glance at, not a hold on stock,
which is why it is shown beside the balance rather than taken off it.

## What it costs

Stock on hand means nothing for such a lot while it is open, and it cannot take
part in a stock count. That is the trade the shop is already making by not
counting what arrived.

Verify: `npm run verify:open-lot` — eight invariants, including that a sale
naming nothing takes the counted stock and leaves the open lot alone, that the
supplier is owed for what sold out of it, that nothing reaches the stock ledger,
and that finishing it frees the code and stops further sales.
