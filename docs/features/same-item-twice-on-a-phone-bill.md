# The same item, twice, on a phone bill

Status: delivered 2026-10-02 (no database change)
Applies to: `mobile-app` (Create a bill)

The phone kept one line per item: billing rice twice added to the first line
instead of writing a second one. The desktop has always written a line per
entry, which is what a market needs — two weighings of the same rice are two
different weights at possibly two different prices, and the customer should
see both.

## How a line is added now

- **Tapping the item** means one more of it. A plain item piles onto the line
  it is already on; an item that is weighed cannot be counted up without a
  weight, so tapping it starts a line and asks.
- **"Add another line"**, under the lines on the item's card, always starts a
  separate line, whatever is already there.
- Each line carries its own −, its measures, and its +. On a weighed line the
  − takes the whole line off, since there is nothing to count down.
- Lines of the same item are numbered on the card (`1 ·`, `2 ·`) and named in
  the review (`Line 2 of 3`), so a repeat reads as meant rather than as a
  double entry.

A line carries a `lineId` of its own in `MobileBillLine`, which is what tells
two lines of the same item apart on screen. Nothing else changed: the bill
still travels as a list of lines, the server already stored them by `line_no`,
and the POS inbox already read them in order.

## The keyboard

With a keyboard — and a tablet on a counter will have one — a line can be
filled without touching the screen:

- **Enter** in the search box bills the item it can only mean: a code typed or
  scanned in full, or the single item left after narrowing. A barcode scanner
  ends its read with Enter, so a scan now bills. The box keeps the focus, ready
  for the next scan.
- In the line sheet **Enter walks the fields** in the order they are read:
  Measured Qty, then Unit Count, then the price, then the reason if the item
  asks for one. Enter on the last field keeps the line.
- For an item kept in two measures, **Measured Qty is now the first field**,
  where the focus already was. The weight is what is read off the scale first.

Covered by `test/mobile_billing_screen_test.dart`: two lines of a plain item,
a line per weighing, and the field order with Enter walking it.
