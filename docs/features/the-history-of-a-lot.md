# The history of a lot

The lot codes list answers one question: what can the counter sell from today.
It holds only lots with stock in them, and a lot drops off it the moment it is
empty. The other question — *what happened to that lot* — had no screen at all,
and it is the one asked months later, when a supplier disputes a load or an
owner wonders what a delivery really earned.

Under the lot codes list, **All lots** is that screen.

## Why it is paged

The list of lots only grows. Every delivery adds to it and nothing ever leaves,
so it is read a page at a time (25 by default, newest first) with a search and
two filters — still selling, or finished. The search covers what a person would
actually have in their hand: a code, an item, a supplier, a GRN number, a
vehicle number.

## A lot is its record; a code is only what was typed

`lot_code` — `SUP-KARU-20260902-3-1` — is the lot's identity and never changes.
Bills, costs, counts and ledger entries all hang off it.

`lot_tag` is the short code a cashier types, and it is editable in place, so it
cannot be trusted to say what a lot *was* sold under. The codes shown against a
lot are therefore read back from the bills themselves: every distinct
`invoice_items.supplier_code` on a line that named this lot. A lot billed as
BONS, renamed, then billed as BONSI shows both.

Two limits follow from reading it this way, and both are the honest answer:

- a code that was typed, then edited away **before anything was billed under
  it**, leaves no trace anywhere and cannot be shown;
- only lines that *named* the lot count. A line that reached it through FIFO
  carries whatever code happened to be in the field, which was never this
  lot's, and showing it would be a lie about where the goods came from.

## What one lot shows

The summary is in four parts, and the order is deliberate: what it is, where it
came from, what it cost, then what it earned.

1. **Identity** — the lot record, the codes it was billed under, the day it was
   created, the day it was finished and why, and whether it is owned or
   consignment.
2. **The delivery** — GRN number and date, vehicle, external reference, what
   arrived in both measures, what is still on the lot, what has gone out, and
   what bills still being written have booked against it.
3. **Lot expenses** — every cost attached to it from `expense_allocations`,
   with its reason and how it was shared across the delivery, and their total.
4. **Sales** and **the bills that carried it** — both loaded only when asked
   for, and only for a role that may see lot costs.

## The figures first, the lists behind them

A lot's record had grown into one long column of sections, which is a tiring
way to answer a question anybody asks in a second: how much of this lot has
gone, and what did it cost me.

So the page opens with the figures themselves -- arrived, still on the lot,
sold, on hold, sent out, wastage, everything gone out altogether, lot expenses,
and what is owed to the supplier -- each one a number large enough to read
across a desk, with its second measure under it. A figure that is zero because
nothing of that kind ever happened to this lot is left out rather than shown as
a nought; the Movements tab still lists every kind.

Underneath, the detail sits in five tabs -- Delivery, Movements, Expenses,
Sales, Bills -- so one part is open at a time instead of all five at once.
Nothing was dropped in the rearranging: every row that was on the page is still
on it, one click away. Sales and Bills keep their own load buttons inside their
tabs, because they are the heavy, permissioned reads.

## What has left this lot

Goods leave a lot three ways, and the summary adds all three up in both
measures: **billed**, **sent out** on somebody else's lorry, and **lost** to
wastage, damage or a return to the supplier. Each is listed underneath with its
reason, its lorry or its destination, and the day it happened.

A fourth figure sits with them and is deliberately **kept out of the total**:
what bills still being written have booked. Nothing has left on those, so
adding them in would overstate the lot. The total line carries the second
reading beside it -- what it would come to once those bills are finished -- so
both questions are answered without either number pretending to be the other.

For a lot nobody counted, this total is also what it will be recorded as
having received when somebody finishes it.

## Money is asked for, not shown

A lot that ran for a month has hundreds of sale lines, so loading them with the
page would make every visit pay for something most visits do not want. Both
sections sit behind their own button.

They also sit behind `lot-costing.view`, the right that already governs what a
lot cost and earned. The list of lots and a lot's own record need only
`receiving.view`: a receiver can see what arrived and what became of it without
seeing what the shop made on it.

## Sale lines are the lot's own share

A sale line can be served by more than one lot. What is shown here is this
lot's share of that line — its measures, and the merchandise in the same
proportion — so the figures add up to what the lot actually gave, not to what
the customer was charged.

A return is a line of the same shape with its measures negative, dated the day
it came back rather than the day of the sale. That way a returned sale nets
itself out wherever it lands: in the day it belongs to, in the price it was
sold at, and in the lot's total.

A return is written against the allocation it undoes, not against a bill line
of its own, so it reaches its item through that allocation. A query that joins
`lot_sale_allocations` straight to `invoice_items` silently drops every return.

**Two ticks**, which stack:

- *Group by price* adds the lines up by item and rate — the shape a supplier
  statement is read in.
- *Break by days* splits them into days first, each with its own totals, and
  the lot's whole total underneath.

Both measures and the merchandise total are carried on every total line.

## Bills are whole, and that is the point

A bill appears once however many of its lines came from the lot, and its money
is the **whole bill's** — all charges, discounts and tax, less what has been
refunded. Most such bills also carry goods from other lots. That is deliberate:
the question this list answers is "who took this lot away and did they pay",
and the answer is the sum on their bill, not an arithmetic share of it.

They can be read as a list or as cards, newest or oldest first, and split into
settled and unsettled — each half with its own totals, because what is still
owed is usually what is being looked for.

Clicking one opens it in the invoice archive.

## The way back

The archive is opened from several screens now, and a link is spent the moment
it is applied: the parameters are cleared so a reload does not repeat it. The
way back therefore cannot live in the address — it is held in
`PageLinksService` as a return target, set when the link is made and good for
one trip.

Because it is a link of its own rather than browser history, it comes back to
the **lot**, not to the lot list: `/receiving?open=lot-codes&lot=172`. The trip
back lands where the trip out started.

## Attaching a cost to the right goods

A cost put on the wrong lot is quiet: nothing looks broken, and the error only
shows up months later in what the goods are said to have cost. So the picker on
the cash-out screen states the goods rather than implying them.

Typing the short code a cashier uses -- `KAR1` -- picks that lot **and** its
delivery outright, because that code is what anybody standing at the counter
actually knows the goods by. It only does so when exactly one lot answers to
the code; anything less certain is left to the list, where each delivery and
each of its lots is one click, with its quantities beside it.

Whatever is chosen is then restated underneath -- "This cost goes on BONS · B
Onion, 355 BAG · 224 KILO billed" -- with the lot's own record below it. An
uncounted lot shows what it has been billed for, since it has no balance to
show.
