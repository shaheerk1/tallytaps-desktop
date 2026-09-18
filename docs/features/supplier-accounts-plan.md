# Supplier Accounts

Status: phase 1 delivered 2026-09-18 (migration 119). Phase 2 (cheques) next.
Applies to: `desktop-app` (new page: Supplier Accounts)

## Why This Exists

Supplier statements already give a full, accurate summary of what happened to
a delivery: what was sold on consignment or bought, the commission, the credits,
and the lot expenses deducted. Finalizing one means the business now owes the
supplier its **BL / Net payable**. What was missing was the rest of the cycle:
paying the supplier, seeing what is still owed, and showing the supplier the
same record we keep.

## Owner's Decisions

| Question | Decision |
| --- | --- |
| What the balance is built from | **Finalized statements + payments.** The old automatic GRN/sale ledger is left out, so nothing is counted twice. |
| Other entries allowed | **Opening balance** (once per supplier) and **manual adjustments with a reason.** No "money received from supplier" entry for now. |
| Cheques | **Phase 2**, together with the cheque register work: our own cheques issued to suppliers, passing a received customer cheque on to a supplier, and unifying bank accounts with funds. |
| Where payments are recorded | **This page only.** A drawer payment still shows in Cash Management's shift activity ("Supplier payment"), and fund payments in the Money fund ledgers. |
| Commission in the detailed view | **With deductions**, in the "Paid / deducted" column. |
| A statement voided after finalizing | **Keeps its line, plus a reversing line** on the void date, so a sheet already shared still matches history. |

## The Balance

From the business's side: **plus is what we owe the supplier, minus is what the
supplier owes us.**

| Adds to what we owe (+) | Takes from what we owe (−) |
| --- | --- |
| Sales subtotal (consignment) / Purchase subtotal (owned) | Commission |
| Statement credits (e.g. an old balance) | Statement deductions (lot expenses, charges) |
| Opening balance "we owed them" | Payments |
| Adjustment "add to what we owe" | Opening balance "they owed us" |
| Reversal of a payment | Adjustment "reduce what we owe" |

## The Page

**Supplier list** — suppliers with any activity (or all, with a switch), newest
activity first: name and code, last activity, number of finalized statements,
last payment, and the balance marked *to pay*, *owed to us* or *settled*.
Filters: search, We owe / They owe us / Settled. Quick actions: **View account**
and **Record payment**. Totals at the top: what we owe suppliers, and what
suppliers owe us.

**Account sheet** — the shareable record, as a table:

Date · Time · Reference (statement number, GRN numbers, lot codes, entry
number) · Description · **Owed to supplier (+)** · **Paid / deducted (−)** ·
**Balance** (running).

- **Detailed / Compact** toggle. Detailed splits each finalized statement into
  its subtotal, commission, each credit and each deduction. Compact shows each
  statement as one line at its net payable (in the minus column if the net is
  negative). Both end on the same balance.
- **Date range** with a *Balance brought forward* line, and period totals.
- **Save PDF** and **Save Excel**. The PDF is drawn by Chromium from HTML so
  Sinhala and Tamil names print correctly (the built-in PDF writer cannot). The
  sheet is rebuilt from the database for the export, never taken from the screen.
- Actions: **Record payment**, **Adjustment**, **Opening balance** (until one
  exists), and **Reverse** on any payment, opening balance or adjustment.

## Recording Money

- **Payment**: amount, paid from (this counter's drawer, safe, bank, or a
  partner's pocket), optional reference and note. The drawer is taken from its
  open shift; a partner's pocket makes the business owe that partner. A payment
  larger than the balance is allowed and leaves the supplier owing us (an
  advance), with a warning.
- **Opening balance**: once per supplier, "we owed them" or "they owed us".
- **Adjustment**: up or down, always with a reason.
- **Earlier dates** follow the money back-dating rules (`money.backdate`,
  a reason, never from a till).
- A repeated save cannot record twice (request id).
- **Reverse** writes an equal and opposite entry. A payment's money goes back to
  the fund that paid (a till payment only while its shift is still open), and a
  partner's claim is taken back. The original stays on the sheet, struck
  through. Nothing is reversed twice, and a reversal cannot be reversed.

## Books

Only money that moved posts to the journal: a payment is *Supplier payables
(2010) debit, the paying fund credit*; its reversal mirrors it. Statements,
opening balances and adjustments stay on the supplier account, as statements
always have. Supplier payables in the books still carries the old automatic
GRN/sale accruals, so it will not equal the sum of supplier account balances
until that is reconciled with the Cost of goods redesign.

## Data

- `supplier_account_entries` (migration 119): payment, opening_balance,
  adjustment, reversal. `effect` is `owe_more` / `owe_less`; append-only, with
  `reverses_entry_id` / `reversed_by_entry_id`, request id, fund and cash/fund
  movement links.
- Statements are read from `supplier_sale_statements` (finalized, and voided
  after finalizing) with their adjustments, GRN links and purchase-line lots.
- Permissions: viewing needs `supplier-settlements.view`; recording or
  reversing needs `supplier-settlements.manage`.
- IPC: `supplierAccounts.list`, `.sheet`, `.pay`, `.openingBalance`, `.adjust`,
  `.reverse`, `.export`.

## Verify

`npm run verify:supplier-accounts` — 8 checks through the real IPC channel:
statements on the account, detailed vs compact, payment from a fund with its
journal posting and no double payment, till payment, opening balance once and
adjustments with a reason, payment reversal, voided statement, and date range.

## Phase 2: Cheques (next)

- Pay a supplier by **our own cheque**: an issued cheque in the register; if it
  is cancelled, stopped or returned, the payment is reversed automatically.
- **Pass a received customer cheque** to a supplier as payment.
- Make the issued-cheque **bank accounts** the same thing as **bank funds**, so
  one list of bank accounts serves funds, cheques and deposits.
