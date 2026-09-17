# Cash Out, Expense Reasons, And Lot Expenses On Statements

Status: delivered 2026-09-17 (migrations 116, 117)
Applies to: `desktop-app` (Cash Management, Money, Supplier Receiving → Supplier sales statements)

## Why This Exists

The Money page, Cash Management and supplier statements grew one at a time,
and each had its own idea of a cost:

- Cash going out offered "Other cash out", "Safe drop" and "Bank drop", which no
  longer matched how money is recorded now that expenses and funds exist.
- Expense reasons were fixed in the database with no way to add or change them.
- A cost that belonged to a delivery was recorded first and attached to goods
  later, and supplier statements typed the same cost again as a deduction.

This round connects them. Cost of goods, supplier payments against statements,
and the stock control effects on lots are **not** changed yet; they come next.

## Owner's Decisions

| Question | Decision |
| --- | --- |
| Where reasons are set up | A new **Expense reasons** tab on the Money page |
| What a lot expense names | The **GRN** (required); a lot is optional |
| Who bears a deducted lot expense | Books unchanged for now: statements stay evaluation-only, Cost of goods still counts it as our cost. Revisit with Cost of goods. |
| Safe and bank drops | **Removed from Cash Management**; done from Money → Move money |
| Plain "other cash out" | Gone: **every cash out is an expense** with a reason |
| Deducting one expense on several statements | **Once only**, on a reviewed or finalized statement |
| Keeping GRN lists short | **Date range** (last 30 days by default) **and hide settled** on owned purchase |
| Supplier payments against statements | **Later**, separately |

## Cash Management

Cash coming in is unchanged. **Cash going out** is now an expense:

1. **What was this for?** — the location's expense reasons, "Other expense" first chosen.
2. For a lot expense, the **GRN** it was for (recent GRNs listed, search for older), and optionally one lot.
3. **Amount** and **what exactly it was for**.
4. **Paid from** — this drawer by default, or the safe, a bank account or a partner's pocket.

Only the drawer changes the shift's cash; the screen says so before saving. Paid
from a partner's pocket, the business owes them the amount, as on the Money page.
The expense goes to the expense register either way.

Every till now has a fund account (migration 117 for existing drawers, and on
opening a shift for new ones); before this, drawers created after migration 089
had none and could not pay an expense.

## Expense Reasons (Money → Expense reasons)

- Two lists: **Lot expenses** (belong to received goods, always name a GRN) and
  **Shop expenses** (costs of running the business).
- **Other expense** is always offered and cannot be switched off, so something
  that fits no reason can still be recorded before anything is set up.
- The reasons that ship with the app are shared by every location. Changing one
  here creates this location's own copy with the same code, which then stands in
  for the shared one at this location only.
- A reason's name must be unique; past expenses keep the reason and kind they
  were saved with (`treatment_snapshot`).

## Lot Expenses

A lot expense recorded on the Money page or in Cash Management must name its
GRN, and is attached to that GRN's lots **in the same save** — split by weight
when every lot was weighed, otherwise by package count, or put on the one lot
chosen. The attach queue on Cost of goods remains for older unattached expenses
and for recurring schedules, which cannot know the delivery.

The rule is enforced in `expense.service.js`: anything arriving over IPC must
name the GRN. Only main-process code with no request in flight (recurring
schedules, the verifiers) may record a lot expense to attach later
(`attachLater`); a screen sending that flag is still refused.

## Supplier Statements

In **Supplier credits and deductions**, the lot expenses recorded against the
statement's GRNs are listed and ticked as deductions:

- **Owned purchase**: the GRNs being paid.
- **Consignment**: the GRNs ticked for comparison.

Each can be unticked, and **Leave out all attached expenses** unticks them all.
Typed credits and deductions stay exactly as before, below the list.

- The amount is what the expense put on those GRNs' lots (after any cost taken
  off or moved), always read from the expense, never typed.
- A deduction line keeps its `expense_entry_id` (migration 116).
- **Once only**: an expense on a reviewed or finalized statement is shown as
  already deducted and cannot be ticked elsewhere. Reopening or voiding releases it.
- Review and finalize re-check: a reversed expense, one moved off the GRNs, or a
  changed amount stops the statement until it is saved again.

### GRN lists

Both tabs list GRNs from a date range (last 30 days by default). GRNs already on
the statement always stay listed. On **Owned purchase**, a GRN whose every line
is on a finalized purchase statement is **settled** and hidden, with a
"Show settled GRNs" switch.

## Verify

`npm run verify:lot-expense-flow` — 6 checks through the real IPC channel:
reasons per location and the fallback, a lot expense naming and attaching to its
GRN, till cash out as an expense, statement deductions from expenses, once-only
and reversal, and GRN list filtering.
