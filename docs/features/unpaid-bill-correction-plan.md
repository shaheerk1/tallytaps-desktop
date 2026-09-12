# Moving A Paid Bill Back To Unpaid

Status: delivered 2026-09-12
Applies to: `desktop-app` (Invoice Archive, billing repository)

## Why This Exists

A bill gets closed as paid and then the money turns out not to be there: the
card declines after the receipt prints, the cash in the drawer is short, or the
customer says "put it on my account" once the sale is done. Until now the only
tool was a refund, which also takes the goods back — wrong, because the goods
left the shop.

## What It Does

**Invoice Archive → a settled bill → "Mark unpaid"** (permission
`billing.payment.reverse`). Enter how much of it is really unpaid, which tender
failed if the bill had more than one, and why. Then, in one transaction:

1. a reversing payment line is written against the tender that failed
   (`payments`, `document_type = 'payment_reversal'`, negative amount), so the
   day's takings by method stay truthful;
2. cash is taken back out of the drawer it was counted into, as a `correction`
   movement in that shift;
3. the bill's `paid_total` falls, its `balance` rises, and it reads as
   `partial` — a sale that stands, with money owed against it;
4. the customer's account carries the debt
   (`customer_receivable_entries`, `payment_reversal_debit`, migration 111).

Collecting it later is the ordinary "Collect outstanding balance" flow already
on the same screen, so nothing new has to be learned to finish the story.

## Rules

1. **Cash only moves while its shift is open.** Once a shift is closed and
   counted, its cash figure is evidence of what was in the drawer; it must not
   change afterwards. The refusal names the alternative: a cash correction in
   Cash Management, or a refund.
2. **The debt must belong to somebody.** A bill with no customer is refused,
   with a pointer to "Assign customer" on the same screen. This is why the
   feature is tied to customer accounts at all.
3. **A cheque is not this.** A cheque that does not clear is a dishonour in the
   cheque register, which already restores the balance and debits the customer.
   The attempt is refused with that instruction.
4. **Stored advance is not this.** Money taken from a customer's advance has to
   go back through the advance screen, or the advance ledger and the receivable
   ledger would disagree.
5. **Never more than was collected.** The amount is capped at the bill's
   `paid_total`, and at the chosen tender's own amount.
6. **Administrators only, by default.** Moving money out of a day's takings is
   exactly what a dishonest entry looks like, so the permission is granted to
   `admin` alone and must be given deliberately to anyone else.
7. **Nothing is erased.** The original tender line stays; the reversal, the
   drawer correction and the receivable entry each carry the reason and the
   person who did it.

## Verify

`npm run verify:unpaid-bill` — nine checks, all rolled back: card and cash
paths, partial moves, the customer balance, the day's takings netting out, and
each refusal (no customer, too much, counted shift, cheque), ending with a
collection that settles the bill again.
