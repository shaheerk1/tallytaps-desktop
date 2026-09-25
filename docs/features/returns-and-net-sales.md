# Returns: both measures, and the real sale

Status: delivered 2026-09-25 (no migration needed)
Applies to: `desktop-app` (Refund, Invoice Archive, Reports), `server-app` + `mobile-app` (bill view)

## What was wrong

1. **A dual-unit return guessed the second measure.** Only the measured amount
   (kilos) was entered; the unit count was worked out in proportion. Three bags
   of 60 kg returned as 35 kg took back 1.75 bags, so the packaging charge came
   back as 28 instead of the 20 for one bag.
2. **The bill view said nothing about the return.** The archive showed the
   original lines, the original total, then a smaller outstanding amount, with
   nothing to explain the difference.
3. **"Exclude returned lines" dropped the whole line.** A line returned in part
   disappeared from the sales report, so the part the customer kept vanished
   from the figures.
4. **The phone never saw returns at all** on a bill.

## How a return is worked out now

A sale charges three things on different measures, so a return undoes each on
the measure it was charged on:

| Amount | Charged on | A return follows |
| --- | --- | --- |
| Goods | the pricing measure (per kg, or per unit) | that same measure |
| Packaging | the unit count (per bag) | the unit count |
| Wage | whichever measure it was set on (per kg or per unit) | that measure |

A dual-unit line is therefore returned in **both** measures, entered separately,
each capped at what is left on the line. Either charge can still be **kept**
(*Do not refund*) or **entered by hand** (*Custom*), and neither can exceed what
is left of that charge. A single-measure line works as before, with the unit
count as its one input.

The share used for each amount is kept on the returned line (`metadata.basis`),
so a later question about an old return can be answered.

## Where returns now show

- **Invoice Archive** — under each sale line, what came back in both measures
  with its split (goods, packaging, wage), and in the totals a **Returned**
  line per return, its reason, and **NET AFTER RETURNS**.
- **Reprint / PDF** — the returned amounts per line, the returned charges, each
  return in the totals, and *Net After Returns*.
- **Reports** — the tick is now **Take off returns**: returned amounts come off
  each line instead of the line being dropped, so the figures are the real sale.
  A line returned in full leaves the report; a part-returned line is marked
  *Part returned*. The header shows **Returns taken off**. Unticking shows every
  line at what it was sold for.
- **Phone (Monitor → bill)** — each return with its split, a *Net after returns*
  line, and a **Returned items** card listing what came back in both measures.
  The server reads the returns already in the archive; nothing new is synced.

## Verify

`npm run verify:refund-measures` — 6 checks through the real IPC channel: a
dual-unit return with packaging by the bag and wage by the kilo, kept and
hand-entered charges with their limits, the finished total, the bill view's
split, the report taking returns off (and dropping a fully returned line), and
nothing returnable twice.

## Follow-up (2026-09-25): a refund leaves the account it came from

A sale paid by card (or any tender that is not cash, cheque or advance) puts the
money into a named fund account. The refund payout dropped that account on the
way through `validatePayments`, so the money was handed back but never left the
account: the fund balance stayed as if the sale still stood.

- The payout now keeps its `fundAccountId`, and one is **required** for any
  payout method other than cash, cheque or advance. The repository already
  wrote the fund movement out; it simply never received an account.
- The refund screen shows **Paid from**, defaulted to the account that took the
  money on the original bill, and a line saying how the bill was paid.
- Cash still leaves the drawer through the shift, a stored advance still only
  moves between documents, and neither names an account.
- No data fix was needed: no past payout had been saved without an account.

Verify: `npm run verify:refund-funds` — a card sale into an account, the account
shown to the refund screen, a payout refused with no account, the money leaving
the account it names, and cash untouched.

## Follow-up (2026-09-28): report filters take several codes

The Supplier and Customer boxes on the sales report now read a comma-separated
list ("SS, CC"), each piece still matching part of a code. The supplier box also
matches the supplier whose lot the goods came out of, not only the supply code
typed on the line, because both are fair ways to ask "what did we sell of
theirs". Covered by `npm run verify:refund-measures` (step 6).
