# Following an entry back, and tidying expenses

Status: delivered 2026-10-14 (no database change)
Applies to: `desktop-app` (Cash management, Money → Expense reasons)

## An entry leads back to its bill

Customer Accounts could already open the bill behind a row. Cash management
could not, although every entry knows where it came from: `cash_movements`
carries `reference_type` and `reference_id`.

The drawer read now follows those back to the bill itself. Money taken at the
counter, change given back and a debt collected all name the invoice directly —
a collection writes `reference_type = 'invoice'` the same as a sale does — and
goods returned name the refund, which names the bill. Those entries are now a
link, and open the invoice archive through the same `page-links.service` that
Customer Accounts uses, with returned bills shown so a fully reversed one can
still be found.

## An expense in the open shift can be taken back out

Cash put in by hand could be edited or removed; an expense could not, although
it is the commonest thing to get wrong at a counter.

**Remove** reverses the expense — not the drawer entry. The expense also took
money from a fund, may have been attached to goods, and wrote a journal entry;
undoing only the cash would leave the other three standing. `expenses.reverse`
already did all of it properly and simply had no way in.

**Edit** reverses the old one and records the corrected one. That is what a
ledger which never deletes can offer, and both stay in the records. A cost that
belonged to a delivery is recorded against the same delivery again.

One thing worth knowing for anything built on this: an expense's drawer entry
holds the expense **number** in `reference_id`, not its id. The link is made
through `expense_entries.cash_movement_id` instead, which also leaves a reversed
expense out, so a reversed one offers no buttons.

## Lot money and shop money, told apart

The movement history has a filter for **lot expenses** or **shop expenses**,
read from the treatment each expense was saved with. The two look alike in a
drawer and are nothing alike in the books: one lands on goods, the other on the
shop.

## Removing an expense reason

Money → Expense reasons could add and edit; it now removes.

A reason nothing has ever used is deleted outright. One that expenses or a
standing charge already name is **switched off instead**, because deleting it
would leave those records naming a reason that no longer exists. The message
says which happened and how many expenses hold it. "Other expense" can never be
removed, as it is what anything unexplained falls back on.

Verify: `npm run verify:cash-links` — eight invariants, including that reversing
an expense puts the money back in the drawer, that it cannot be done twice, and
that an unused reason goes while a used one only goes quiet.
