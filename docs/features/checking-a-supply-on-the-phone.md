# Checking a supply on the phone

Status: delivered 2026-10-14 (no database change on the POS)
Applies to: `server-app` (a new monitor read), `mobile-app` (Business Monitor →
Supply → **Check**)

Days after the goods went out, somebody has to work out what one supply came to.
The desktop does this properly, through Supplier Sales Statements, with locked
lines and everything a real statement needs. On the phone the job is different:
a quick check over several days, where the supply code was typed at a counter
and one of them is usually wrong.

So this is the loose version of that page. It lists the sale lines themselves,
lets a person pick the ones that really belong, and adds them up the way a
statement does.

## The supply code was already there

`invoice_items.supplier_code` has existed since migration 059 and carries the
cloud sync stamp, so every billed line has been reaching the server with its
supply code on it all along. **No rework was needed in the POS, and none in what
it uploads.**

What the server did not have was a way to *list* those lines. Its sales reads
were all totals: `salesItems` groups by item and supply code, and the lines
themselves could only be seen one bill at a time. So one read was added:

- `GET /monitor/sale-lines` — every line in a range, with the supply code, the
  rate, both measures and what came back, plus the item codes the range holds so
  the phone can offer them to pick from.
- Filters: several **item codes** and several **supply codes** at once, both
  case-insensitive, plus a free search over item, description, supply code and
  customer code.
- Returned goods are taken off the line they came back from rather than hidden,
  because a half-returned line still belongs on the list at what is left.
- The item codes offered back are narrowed by the supply codes but never by the
  item codes themselves: a list that hid what is not already chosen could not be
  chosen from.

Covered by `test/monitor-sale-lines.test.js` — five checks, including that one
shop never sees another's lines.

## On the phone

The shop and the date range come from the monitor's own header, so this view
only adds what is particular to it:

- **Supply codes**, typed comma separated. Several at once is the point: a day
  goes out under more than one, and `PER` is sometimes typed `PRE`. The lines
  for both come back together and the person leaves out what does not belong.
- **Item codes**, picked from a searchable list built from the range itself.
- Every line can be ticked, and **Select all listed** takes whatever the filters
  are currently showing.

The summary opens from the bar at the bottom and is grouped **by item and by the
rate it went out at**, because the same goods often leave at two or three prices
in a day. Each row shows both measures and what it came to. Two dials sit above
it:

- **Break it down by date** — the same summary, one section per day.
- **Sale commission %** — taken off the goods value to give the net payable.

With the days broken out, each day carries its own commission and net, and the
total is the **sum of the days** rather than a figure re-derived from the whole,
so what is shown adds up to what is totalled, to the cent.

Packaging and wage charges are counted but kept apart from the goods value, and
said so underneath; a supply is settled on the goods.

## What it deliberately does not do

No locked lines, no pasting from a spreadsheet, none of the statement machinery.
A check is one person's working out, not a document the shop owes anything
against. The same line may be used in two checks on purpose — one supply looked
at from two angles — so instead of locking, a line quietly says **"already in 2
saved checks"** when it is.

A check can be **saved on the phone** and read back later, with the lines it was
made from rather than only its totals, so it survives the host being out of
reach and never changes under the person who saved it. Nothing is sent to the
POS. Phone database v8 adds `supply_checks` and `supply_check_lines`.

Covered by `test/supply_check_test.dart` — eight checks over the grouping, the
commission, the day-by-day totals adding up, returned lines, and a saved check
reading back the same figures.

## The supply code on the bill itself

Once a supply code is worth checking, it is worth seeing where it came from. A
bill opened on the phone now shows each line's supply code beside the item, as a
small chip, and so does each returned line underneath — a return belongs to the
same supply as the sale it came back from. The server already sent the code on
sale lines; it now sends it on refund lines too.

The chip is one widget (`SupplyCodeChip`) shared with the supply check, so the
code reads the same wherever a line is shown. A line billed without a code shows
nothing rather than an empty chip.

The desktop's Invoice Archive has shown this all along, as `SUPPLY~ITEM` on the
line and on the reprint. The customer's own printed bill is deliberately left
alone: a supply code is the shop's business, not the buyer's.

## A supply code may hold spaces

Plenty of them do: `SBT IO BEST` is one code, not three. **Only a comma starts
the next code**, so `b1,SBT IO BEST` is two and `SBT IO BEST` on its own is one.

The first build got this wrong in a way that would have been hard to spot. The
controller ran each typed code through `code()`, the strict
`[A-Za-z0-9_-]` pattern that guards the shop and counter a request is scoped by.
A code with a space in it failed that test and was **dropped silently**, so the
filter came back empty-handed and listed every line in the range — the opposite
of what was asked for, with nothing to say why.

Typed codes now go through their own check, which allows anything printable up
to 64 characters and only rejects control characters. That is the right place
for the line: a shop or counter code names a place and is used to scope a query,
so it stays strict; a supply code is data typed at a counter and is only ever
compared against other data, through bound parameters.

Spacing inside a code is tidied on both sides before comparing — `SBT  IO best`
and `SBT IO BEST` are the same supply — so neither a stray double space nor a
capital letter makes a second code out of one.

## The supply page's own controls

Five views would not fit a phone as a segmented button: the labels squeezed
until none of them could be read. The views are now pills in the same strip the
app's own tabs use -- the one you are standing in lifted out in white with its
own colour -- and they **wrap onto a second line** rather than shrinking. Each
view carries a tone of its own so the eye finds where it left off.

Three controls that had been written three times are now written once, in
`monitor_widgets.dart`, and shared by every view:

- `MonitorViewPicker` — the wrapping pills above.
- `MonitorSearchField` — one search box, with a clear button and a focus ring.
- `MonitorFilterChips` — narrowing a list to one of a few states.

The supply check's two filters sit in one card so they read as one question --
which supply, and which of its items -- with the codes in play shown as chips
beneath and a line saying what the filters left.

## A line that came back whole is not a line

If every measure of a line was returned -- the count and the weight both back to
zero -- it is not part of any supply any more, so it is left off the list
entirely. A line only partly returned stays, at what is left of it, because that
part still belongs to the supply. A line where only one of its two measures came
back also stays: the memory of this system is that a return follows the measure
it was charged on, so bags kept while the weight went back is a real thing.

This is done in the query rather than on the phone, by joining the returns to
the lines they came from. That keeps the count of lines honest and the paging
right: dropping rows after the limit would have left a page of 200 showing 180
and still claiming 200. The item codes offered to pick from are counted the same
way, so a code is never offered with nothing behind it.

The returns are searched from the first day of the range onward, since a return
is never dated before its sale. There is no upper bound -- goods can come back
later than the range -- so this is the one read here that grows with history.

## Handing the supplier a statement

A check adds up to a figure somebody has to be told. The summary can be sent as
a **picture**, which is what a supplier opens without thinking about it, laid
out like the statement the desktop prints: the same warm paper (`#fffdf8`), the
same banded head, and the columns a supplier reads --

    ITEM | UNIT COUNT | MEASURED QTY | RATE | LINE TOTAL

-- over totals for the unit count, the measured quantity, the merchandise
subtotal, the commission and the net payable.

**It carries the goods and the money and nothing else.** No supply code, no
customer, no bill number, and the item is named rather than coded. A supplier is
owed for what went out at what price; the rest is the shop's own business.

Broken into days, **each day is its own statement**, because that is how a
supply is usually settled, with one for the whole range beside them for when it
is settled in one go. "Send each" walks through them.

The sheet is laid out at its own 860 points whatever the phone is and only then
scaled to be looked at, so the picture taken is the whole statement at full size
rather than the part that fitted on the screen. There is a test for exactly
that, since it is the one thing about this that could be quietly wrong.

An image rather than a PDF, because a supplier opens a picture in the chat they
are already in. A PDF would be a small change from here -- the sheet is one
widget -- if a supplier ever asks for one.

The picture is **written to a real file** before it is handed on. What shares it
copies the picture out of the path it is given, so bytes held only in memory
arrive as a file that is not there -- which is exactly how the first build
failed, with `The source file doesn't exist`. `writeSheet` is a function of its
own so a test can watch the bytes land on disk, and it tidies the name, since a
heading can hold characters a filename cannot.
