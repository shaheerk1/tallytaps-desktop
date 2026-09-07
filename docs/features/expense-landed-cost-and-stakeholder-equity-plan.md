# Expense, Landed Cost, And Stakeholder Equity Plan

Status: active feature plan
Started: 2026-09-07
Depends on: `ddec-wholesale-supply-and-settlement-plan.md` (active)

> **Scope rule:** This plan closes the gap that the DDEC plan deliberately
> deferred under "full accounting general ledger". Build it through explicit
> core services, database records, permissions, and reports, following the
> existing repository → service → container → permission-gated IPC → Angular
> layering. Do not restore plugin-driven or SDL-driven financial behavior.

> **Doc currency note:** The SDL and plugin architecture documents in
> `docs/architecture/` describe systems that were removed from the code by
> migrations 041, 042, and 057. They are historical. Where this plan and those
> documents disagree, this plan and the code win.

## Why This Plan Exists

The POS today records money movement accurately but cannot answer two ordinary
business questions:

1. **What did this lot actually cost me, and what did I really make on it?**
2. **Whose money is in this business, and what can each person take out?**

The reason is structural, not accidental. The system holds four excellent
single-entry subledgers — drawer cash (`cash_movements`), customer debt
(`customer_receivables`), customer advances (`customer_advance_*`), and supplier
debt (`supplier_payable_entries`) — and nothing that connects them. Each answers
"how much does this party owe or hold". None answers "where did the money come
from, and what does it belong to".

Three concrete gaps prove it:

- The word `cost` appears exactly once in the entire schema
  (`goods_receipt_lines.unit_cost`, migration 048). `inventory_lots` carries no
  cost at all, so cost price and net profit per lot are not computable.
- `supplier_charge_types.treatment` (migration 054) declares three treatments —
  `supplier_deduction`, `business_expense`, and `landed_cost`. Only the first is
  implemented. The other two have no destination table anywhere in the schema.
- `cash_movements` requires a `cash_shift_id`, which requires a drawer, which
  requires a workstation. Money held in a safe, a bank account, or a partner's
  own pocket is structurally unrepresentable. `safe_drop` and `bank_drop` are
  exits into a void; nothing receives them.

The codebase already names this gap. From `cheque-register.component.html`:
"Cheques entered directly here are register-only until a full expense/general-ledger
module is added."

This plan adds that module.

## Product Goal

Let a shop owner record every cost the business incurs, attach the ones that
belong to a specific received lot so that lot's true cost price rises, and see
honest net profit per lot, per supplier, and per period — whether the goods were
bought outright or taken on consignment.

Let the same owner record money put in and taken out by owners and partners,
from any source, and see at any moment who is owed what, both for the business
as a whole and for one specific lot or venture.

The result must stay useful beyond DDEC. The reusable concepts are fund account,
expense, allocation, landed cost, stakeholder, and equity entry. DDEC supplies
default categories and treatments, not special behavior.

## Non-Negotiable Rules

1. Every financial record is append-only. A correction creates a new linked,
   audited record with a reason and an actor; it never rewrites history.
2. Landed cost on a lot is a **projection**, exactly like `products.stock_qty`.
   The expense and receipt records are the source of truth, and the projection
   must be rebuildable from them at any time.
3. Money always has a named location. Every expense, contribution, drawing, and
   transfer states which fund account it left or entered. There is no unsourced
   money.
4. A partner paying a business cost personally is a real financial event with
   two effects: the cost belongs to the business, and the partner's claim rises.
   Both must post in the same transaction or neither posts.
5. Owned stock and consignment stock compute profit differently and must not
   share one generic margin formula. `inventory_lots.ownership_model` decides.
6. Double-entry postings are **derived by fixed code from business events**.
   No operator types a debit or a credit in the first release, and no formula
   engine, SDL expression, or plugin may generate a posting.
7. A recurring expense schedule never posts silently. It proposes a due entry;
   a person confirms it.
8. Reallocating a cost away from a lot does not edit the original expense. It
   creates a reallocation record that both lots can show.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Fund account | A real place money sits: a POS drawer, the cash safe, a bank account, or a stakeholder's own pocket. |
| Expense | Money the business spends, with a category, a source fund, and an allocation target. |
| Allocation target | What an expense belongs to: a lot, a GRN, a supplier, or general overhead. |
| Landed cost | Purchase cost plus every expense allocated to that lot. The real cost of the goods. |
| Overhead | An expense that belongs to the period, not to any lot — rent, salary, electricity. |
| Stakeholder | An owner or partner who puts money into, or takes money out of, the business. |
| Contribution | Money or value a stakeholder puts in. Raises their claim. |
| Drawing | Money a stakeholder takes out. Lowers their claim. |
| Profit share | An approved allocation of a period's or a lot's profit to a stakeholder. |
| Journal entry | The derived double-entry record behind a business event. Read-only to operators. |

## Business Flows

### Recording a lot-related cost

1. Open the GRN or the lot.
2. Choose **Add cost to this lot**.
3. Pick a category (repacking, unloading, lorry wage, transport).
4. Enter the amount and choose which fund paid it.
5. If a partner paid personally, choose that stakeholder as the payer.
6. Confirm. The screen shows the lot's new cost per unit before saving.

The lot's landed cost rises immediately. Its profit report updates.

### Recording a cost that belongs to a whole delivery

1. Open the GRN and choose **Add cost to this delivery**.
2. Choose how it splits across the delivery's lots: by kilograms, by packages,
   by sale value, or an equal share.
3. Confirm. Each lot receives its portion, and each portion is traceable back
   to the one original expense.

### Recording an overhead expense

1. Open Expenses and choose **New expense**.
2. Pick a category, amount, and paying fund.
3. Leave the allocation as **General business cost**.

It affects period profit, never a lot's cost price.

### A recurring expense

1. An administrator creates a schedule: category, amount, cycle, paying fund.
2. On the due date the system creates a **proposed** entry in a due list.
3. A person reviews the amount and confirms, edits, or skips it with a reason.

Nothing posts until a person confirms.

### A partner puts money in

1. Open Stakeholders and choose the partner.
2. Record a contribution: amount, which fund received it, and the date.
3. If the contribution funds one specific venture or lot, scope it there.

Their claim on the business rises by that amount.

### A partner takes money out

1. Open the partner and choose **Record drawing**.
2. The screen shows what is available to draw, and what is not yet realised.
3. Record the amount and which fund it left.

A drawing beyond the available claim requires an authorised override with a
reason. It is never silently blocked or silently allowed.

## Core Data Model

Existing tables are extended rather than bypassed. `cash_drawers`,
`cash_shifts`, and `cash_movements` keep their current behavior; the drawer
becomes one kind of fund account rather than the only place money can be.

| Record | Responsibility |
| --- | --- |
| `fund_accounts` | Named money locations: `pos_drawer`, `cash_safe`, `bank`, `stakeholder`. A `pos_drawer` row links to an existing `cash_drawers` row. |
| `fund_movements` | Append-only in/out ledger per fund account, with source document reference and business date. |
| `fund_transfers` | A paired movement between two funds — a safe drop, a bank deposit, a partner reimbursement. |
| `expense_categories` | Named categories with a default treatment: `lot_cost`, `overhead`, or `supplier_deduction`. Seeded with a DDEC set. |
| `expense_entries` | One expense: category, amount, business date, paying fund, optional bearing stakeholder, allocation target, status, reason, actor. |
| `expense_allocations` | The portions of an expense applied to specific lots, with the split basis used. One expense may produce many allocations. |
| `expense_reallocations` | An append-only correction moving an allocation from one lot to another, with reason and approver. |
| `recurring_expense_schedules` | Cycle definition and next-due date. Generates proposals only. |
| `stakeholders` | Owner or partner identity, status, and default treatment for personally borne costs. |
| `stakeholder_shares` | Ownership percentage, optionally scoped to a lot or venture rather than the whole business. |
| `stakeholder_ledger_entries` | Append-only equity ledger: `capital_contribution`, `expense_borne`, `drawing`, `profit_share_allocation`, `settlement`. |
| `journal_entries` / `journal_lines` | The derived double-entry spine. Written only by the posting-rules service. |
| `accounting_periods` | Period open/close control, so a closed period cannot receive new postings without an authorised reopen. |

### Extending `inventory_lots`

```sql
ALTER TABLE inventory_lots
  ADD COLUMN purchase_cost_total   DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN allocated_cost_total  DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN landed_cost_total     DECIMAL(14,2) NOT NULL DEFAULT 0;
```

These three are projections. `purchase_cost_total` comes from the GRN line,
`allocated_cost_total` is the sum of `expense_allocations` for that lot, and
`landed_cost_total` is their sum. A reconciliation routine must recompute all
three from source records and report any drift, in the same spirit as the
existing inventory allocation reconciliation.

### Per-lot profitability

`lot_sale_allocations` already records `quantity`, `kilos`, and `sale_value`
per lot, so the calculation needs no new sales-side data:

```text
Lot sale value                     (sum of lot_sale_allocations.sale_value)
- purchase cost                    (owned lots only)
- allocated expenses               (expense_allocations for this lot)
- commission                       (consignment lots only, from terms snapshot)
- supplier-borne charges           (existing supplier_deduction treatment)
= net margin on this lot
```

Owned and consignment lots take different branches of this calculation. The
branch is chosen by `inventory_lots.ownership_model`, never by a metadata flag.

### Origin keys and business context

Every new financial table follows the hardening pattern established by
migrations 065–073: carry `loc_code`, `mac_code`, `business_date`, and a
sequence number, with a unique origin key. A retried IPC call, a double click,
or a sync replay must not be able to create a second expense, contribution, or
drawing.

## The Derived Journal

Operators record business events. A **posting-rules service** turns each event
into balanced journal lines. Nobody types a debit.

| Business event | Derived posting |
| --- | --- |
| Expense paid from drawer | Expense account debited, drawer fund credited |
| Expense paid personally by a partner | Expense account debited, stakeholder equity or liability credited |
| Expense allocated to a lot | Expense reclassified into inventory value for that lot |
| Partner contribution | Receiving fund debited, stakeholder capital credited |
| Partner drawing | Stakeholder capital debited, paying fund credited |
| Fund transfer | Destination fund debited, source fund credited |

Why this earns its place:

- It is self-proving. If debits and credits disagree, something is wrong — a
  class of error that currently cannot be detected at all.
- New reports need no new tables. Trial balance, profit and loss, balance
  sheet, and partner statements all read one place.
- The four existing subledgers become reconcilable against control totals for
  the first time.
- An accountant gets a real general ledger without the shop owner ever seeing
  one.

Constraints, consistent with the DDEC plan's rejection of a formula engine: the
posting rules are fixed code, journal lines are append-only and reversed only
by contra-entry, and no configuration surface may add or edit a rule in the
first release.

## Progressive Disclosure

One data model, three lenses, chosen per user by permission.

| Mode | Sees | Language |
| --- | --- | --- |
| Simple | Add an expense: what, how much, from which pocket, for which lot | No accounting vocabulary at all |
| Business | Lot profitability, partner balances, expense trends, recurring due list | Cost, profit, owes, available |
| Accountant | Journal, trial balance, profit and loss, balance sheet, period close | Debits and credits |

Three rules that carry most of the usability:

1. **Templates over blank forms.** Ship a DDEC preset of categories with sound
   default treatments, the way `supplier_charge_types` and `payment_modes` are
   already seeded. A beginner picks a preset; an expert edits it.
2. **Allocate from where the user already is.** The highest-value control is not
   an Expenses screen. It is an **Add cost to this lot** button on the GRN and
   lot screens, where the user is already looking at the goods.
3. **Show the effect before saving.** One honest sentence teaches landed cost
   better than a manual.

## Helper Phrases

These are required UI text, not suggestions. Each targets a place where the new
concepts are genuinely hard for a first-time business owner. Write them in the
screen, near the control, not in a help page nobody opens.

### Landed cost and allocation

- On the allocation target field:
  *"Costs added to a lot raise what those goods really cost you. Costs left as
  a general business cost affect your profit for the period instead."*
- On the confirmation preview:
  *"This adds Rs. 4,500 to Lot ONI-0042. New cost: Rs. 118 per kg (was Rs. 112)."*
- When a user allocates an expense to a lot that is already fully sold:
  *"This lot is already sold. Adding this cost now will reduce the profit you
  have already reported on it. That is normal for costs that arrive late —
  continue if this bill really belongs to those goods."*
- On the split-basis chooser:
  *"This one bill covers several lots. Choose how to divide it. By kilograms is
  usual for transport and unloading. By sale value is usual for commission."*

### Owned versus consignment

- On the lot profit report, for a consignment lot:
  *"You did not buy these goods, so there is no purchase cost. Your earning is
  the commission, minus the costs you paid yourself."*
- On the lot profit report, for an owned lot:
  *"You bought these goods, so your profit is the sale value minus what you paid
  for them and every cost you added."*

### Fund accounts

- On the fund account list:
  *"A fund is simply a place your money sits — the till, the safe, a bank
  account, or your own pocket. Recording which fund paid keeps every balance
  honest."*
- On a partner-pocket fund:
  *"Money here belongs to the partner, not the business. When it pays a business
  cost, the business owes them that amount."*

### Stakeholders and equity

- On the contribution form:
  *"Recording money you put in is how the system knows what is yours. Without
  it, your own money looks like business profit."*
- On the drawing form, showing availability:
  *"Available to take: Rs. 84,200. This is your share of profit that is already
  realised, plus what you put in, minus what you have taken."*
- On an over-limit drawing:
  *"This is more than your available balance. Taking it now means the business
  owes the difference back. A manager must approve this."*
- On the partner-paid-expense treatment chooser:
  *"Did this money become part of your investment in the business, or should the
  business pay you back? Choose once per partner; you can change it later for
  new entries."*

### Recurring expenses

- On the schedule form:
  *"The system will remind you on each due date. It will never record the money
  on its own — you always confirm the real amount."*
- On a proposed entry:
  *"Due today from your schedule. Check the real amount before confirming; rent
  and wages often differ from the plan."*

### Period and journal

- On the accountant-mode entry point:
  *"This view is for your accountant. Everything here is built automatically
  from the entries you already made — there is nothing extra to type."*
- On period close:
  *"Closing a period locks it so past figures cannot change. You can still
  record today's work. Reopening needs authorisation."*

## Permissions

Following `permission-model.md`, register each permission only when its UI
action and its IPC guard both exist.

- `funds.view`, `funds.manage`, `funds.transfer`
- `expenses.view`, `expenses.create`, `expenses.allocate`, `expenses.approve`
- `expenses.recurring.manage`
- `stakeholders.view`, `stakeholders.manage`
- `stakeholders.contribute`, `stakeholders.drawing`, `stakeholders.profit-share`
- `accounting.journal.view`, `accounting.period.close`

Intended role split:

- **Cashier** — `expenses.create` only, limited to the open drawer and requiring
  a reason. A cashier never sees allocation, stakeholders, or the journal.
- **Manager** — expense allocation, approval, recurring schedules, fund
  transfers, lot profitability.
- **Owner or partner** — the stakeholder and accounting domains.

Cash paid out of a drawer for an expense must create both an `expense_entry`
and the matching `cash_movement`, in one transaction, so shift reconciliation
stays correct. Expenses paid from the safe, a bank account, or a stakeholder
pocket must not touch a drawer.

**Security boundary, stated honestly:** permissions hide screens and block IPC
channels. They are not database-level security. Anyone with MySQL credentials
can read stakeholder equity regardless of role. If partner-versus-partner
confidentiality is a real requirement rather than a UI convenience, it needs its
own decision — per-role database users, or encryption at rest for stakeholder
amounts. Decide this before Phase 3, not after.

## Delivery Phases

### Phase 1: Fund Accounts And Expense Capture

Status: **delivered 2026-09-07** (migration 089). Verified by
`npm run verify:expense-funds`, which asserts every exit check below against the
real schema inside a rolled-back transaction.

- `fund_accounts`, `fund_movements`, `fund_transfers`, with existing drawers
  wrapped as `pos_drawer` funds and no change to shift behavior;
- `expense_categories` seeded with a DDEC set, and `expense_entries`;
- Simple-mode expense screen and a cashier petty-cash path;
- `safe_drop` and `bank_drop` finally land in a real destination fund;
- fund balance report.

Exit checks:

- an expense paid from the drawer creates both an expense entry and a cash
  movement, and the shift's expected total still reconciles; **passing**
- every fund's balance equals the sum of its movements; **passing**
- a retried or double-submitted expense cannot create two rows; **passing**
- an expense cannot be saved without a category, an amount, and a source fund.
  **passing**

Two rules were settled while building, and both belong to the record:

1. **Balance ownership is split, so no amount is counted twice.** A `pos_drawer`
   fund is a view over the existing `cash_movements` ledger, and its balance is
   what the currently open shift holds — closed shifts were counted and emptied,
   so they are deliberately not carried forward. Every other fund kind keeps its
   own `fund_movements` ledger and starts from its recorded opening balance. An
   expense therefore writes *either* a cash movement *or* a fund movement, never
   both, enforced by a database CHECK constraint.
2. **A fund cannot be overdrawn.** Spending more than a fund holds is refused
   with a message that names the shortfall, rather than silently going negative.

### Phase 2: Allocation And Landed Cost

Status: **delivered 2026-09-07** (migration 090). Verified by
`npm run verify:lot-costing`.

This is the phase that pays for the project.

- allocation targets and the four split bases (kilograms, packages, sale value,
  equal share);
- `expense_allocations` and `expense_reallocations`;
- landed-cost projection columns on `inventory_lots` plus a reconciliation
  routine;
- **per-lot and per-supplier profitability report**, branching correctly on
  ownership model;
- implementation of the long-declared `landed_cost` and `business_expense`
  treatments on `supplier_charge_types`;
- "Add cost to this lot" and "Add cost to this delivery" controls on the GRN and
  lot screens, with the before-and-after cost preview.

Exit checks:

- two lorry-wage expenses on a three-lot GRN, split by kilograms, produce lot
  costs that sum back to the original total to the cent;
- recomputing the landed-cost projections from source records changes nothing;
- a consignment lot shows commission earning and never a purchase cost;
- a late expense on a sold lot restates that lot's margin and says so plainly;
- a reallocation leaves both the original expense and both lots' history intact.

### Phase 3: Stakeholders And Equity

Status: **delivered 2026-09-07** (migration 091). Verified by
`npm run verify:equity-journal`.

- `stakeholders`, `stakeholder_shares` (whole-business or lot-scoped),
  `stakeholder_ledger_entries`;
- contribution, drawing, personally borne expense, and settlement flows;
- available-to-draw calculation and the authorised-override path;
- partner statement, printable and exportable;
- decision recorded per stakeholder: personally borne cost becomes capital or
  becomes a business debt.

Exit checks:

- a partner-paid expense raises the lot's landed cost and the partner's claim in
  one transaction, or neither;
- a drawing above the available balance cannot be recorded without a named
  approver and a reason;
- a lot-scoped partner's claim reflects only that lot's realised profit;
- the sum of all stakeholder claims reconciles to business equity.

### Phase 4: Journal, Statements, And Hardening

Status: **delivered 2026-09-07** (migrations 092 and 093). Verified by
`npm run verify:equity-journal`.

- `journal_entries` / `journal_lines` and the posting-rules service;
- retrospective posting of Phase 1–3 events;
- `accounting_periods` with close and authorised reopen;
- trial balance, profit and loss, balance sheet, accountant mode;
- Excel export following the existing working-copy rules — an exported sheet is
  never a financial source of truth;
- database-backed regression tests for repeated submission, concurrent expense
  allocation, drawing limits, and period-close enforcement.

Exit checks:

- every Phase 1–3 event posts balanced lines, and the trial balance nets to zero;
- the four existing subledgers reconcile to their control accounts;
- a closed period rejects a new posting until an authorised reopen;
- a figure in the profit and loss can be traced back through journal line,
  expense allocation, lot, GRN, and original invoice.

## Decisions Taken While Building

These were settled during Phases 2 to 4 and are part of the contract now.

1. **Allocation rows are signed and append-only.** Moving a cost from one lot to
   another writes a negative row on the lot that gives it up and a positive row
   on the lot that takes it, linked by an `expense_reallocations` header. The
   original allocation is never edited, so both lots keep a complete history.
2. **Splits use largest-remainder rounding.** A bill divided across lots always
   adds back to the whole: 100.00 over 100/200/300 kg becomes
   16.67 + 33.33 + 50.00, never 99.99.
3. **Purchase cost is read from the existing ledger,** not recomputed from
   `unit_cost`. `supplier_payable_entries.purchase_debit` already carries what
   the GRN decided, so the projection cannot disagree with the payable.
4. **A stakeholder pocket is exempt from the overdraw guard.** The business
   cannot know what is in a partner's personal wallet, and a negative pocket
   balance is meaningful: it is what the business owes them.
5. **A stakeholder pocket is not a business fund.** Contributions, drawings and
   settlements must move through a till, safe, or bank account; the pocket is
   the person, not a place the business keeps money.
6. **Balance-sheet groups are summed toward their own natural side.** Drawings
   are a debit-normal equity account, so the balance reduces equity rather than
   inflating it.
7. **Sales are still outside the journal.** Billing remains the source of truth
   for revenue, so the profit and loss reports costs only and says so on screen
   rather than implying a complete profit figure.

## Explicit Deferrals

Not in the first release:

- operator-entered manual journal entries;
- a configurable posting-rule or formula engine;
- multi-currency;
- tax and statutory filing computation;
- depreciation and fixed-asset registers;
- budgets and variance-against-budget reporting;
- a partner-facing portal or mobile equity view;
- automated bank-statement import and reconciliation.

## Decisions To Validate During Phase 1

These are policy choices. They get expensive to change later, and they must be
captured per stakeholder or per lot rather than hidden in code.

- When a partner pays a business cost personally, does it increase their capital
  or create a business debt to repay? Different balance-sheet treatment.
- Are lot expenses allocated at receipt or at sale? Receipt-time is simpler and
  matches how the market thinks; the recommendation is receipt-time allocation
  with an append-only reallocation record for costs that arrive late.
- Can a partner draw against unrealised profit, or only against collected cash?
- Which expense categories default to lot cost, and which to overhead?
- Is profit share allocated per period, per lot, or both?
- Does partner-versus-partner confidentiality require database-level isolation?

## Cross-App Boundaries

- **desktop-app** owns every record in this plan. It is the system of record.
- **mobile-app** may capture a field expense at the moment it happens — amount,
  category, a photo of the lorry receipt, and the lot it belongs to — and sync
  it as a **draft awaiting desktop approval**, exactly as
  `field_transaction_inbox` (migration 064) already does for bills. It must not
  post a final expense, an allocation, or any equity entry.
- **server-app** hosts and archives. It gains no new financial responsibility.

No new application is needed. Financial integrity requires one transaction
boundary, and the lots, GRNs, suppliers, shifts, business days, and invoices
this module depends on already live in one database.
