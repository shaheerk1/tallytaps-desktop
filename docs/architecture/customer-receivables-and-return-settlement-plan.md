# Customer Receivables And Return Settlement Plan

Status: closed historical implementation plan
Closed: 2026-08-06

> **AI development rule:** The receivables, collection, return-settlement, and
> lightweight customer-account workflow described here are implemented. Keep
> this document as financial-behavior reference, not an active feature backlog.
> Plan reporting and any future customer features separately.

## Goal

Make Pending a real customer receivable, not a fake completed payment. Support
small markets that only know a customer name or code, while allowing optional
phone, address, and notes to grow into a lightweight customer registry.

This is not a full CRM. It is a core financial identity and receivables ledger.

## Core Rules

1. A `pending` payment creates customer debt; it never increases tender paid.
2. Every Pending invoice requires a resolved `customer_id`.
3. A return first reduces outstanding debt. Only the remaining customer credit
   can be paid out or retained as store credit.
4. Payments, returns, credits, refunds, and adjustments are append-only ledger
   entries. Never edit historical money rows to change a balance.
5. Cash collections and cash refunds create cash-shift movements automatically.
   They are never entered as generic cash-in/out movements.

## Customer Model

Extend the existing `customers` table rather than adding a CRM module.

Required:

- `id`: internal stable identifier
- `name`: display name

Optional:

- `customer_code`: unique business identifier when a market uses one
- `phone`, `address`, `notes`
- active/inactive state

Rules:

- If `customer_code` exists, it must be unique within the installation.
- A typed code resolves the account first; a typed name resolves an exact or
  selected match.
- When no match exists, Pending completion creates a minimal account from the
  typed value. The operator can enrich it later.
- Duplicate names must be selectable; the system must not silently merge them.

## SDL Contract

SDL continues to render the operator-facing bill header field. Add a bounded
semantic property to input segments:

```json
{ "id": "customer_code", "scope": "bill", "kind": "input", "type": "text", "purpose": "customer_identifier" }
```

Supported purposes:

- `customer_identifier`: customer code or account lookup value
- `customer_name`: display name or name lookup value

Only one customer identity purpose may be active for a tenant/store document.
The field remains optional for cash sales. When a Pending payment exists, core
billing requires a non-empty identity field and resolves or creates the
customer before finalization. The SDL field is not the ledger identity itself;
`invoices.customer_id` is.

Future UI: a purpose-tagged text field can become a searchable picker. It
searches customer code, name, and phone, allows selection, then offers “Create
customer from typed value” when no result exists.

## Ledger Model

Add `customer_receivable_entries` with immutable rows:

- `sale_debit`: original Pending amount
- `collection_credit`: later customer payment
- `return_credit`: return applied to debt
- `refund_debit`: money paid back after debt is cleared
- `store_credit`: customer credit retained for a later sale
- `manager_adjustment`: controlled correction with reason and approval

Each entry links to customer, invoice/refund when applicable, user, workstation
session/cash shift when applicable, amount, direction, reason, and timestamp.
Customer/invoice open balances are derived from entries or maintained as a
transactionally updated projection, never hand-edited.

## Settlement Rules

For an invoice total of 1,815.00 with 1,000.00 tender and 815.00 Pending:

| Return value | Debt reduction | Refund/store credit due | New debt |
|---|---:|---:|---:|
| 500.00 | 500.00 | 0.00 | 315.00 |
| 815.00 | 815.00 | 0.00 | 0.00 |
| 1,200.00 | 815.00 | 385.00 | 0.00 |
| 1,815.00 | 815.00 | 1,000.00 | 0.00 |

The return screen calculates and displays these values before completion. It
must not allow a cashier to pay a cash refund while the normal allocation still
leaves unpaid debt. A manager-only exception may allow a different allocation;
it requires an explicit reason and audit entry.

## Features

### 1. Customer Registry

- Customer list/search by code, name, phone
- Create/edit minimal account with phone, address, notes
- Customer detail shows open balance, open invoices, collections, returns, and
  credits

### 2. Pending Completion

- Detect Pending in payment completion
- Require a configured customer identity SDL field
- Resolve/select/create the account
- Persist `invoice.customer_id`
- Create `sale_debit` for the Pending amount
- Show a clear error when identity configuration/value is missing

### 3. Collect Balance

- Invoice History and Customer Detail action: `Collect balance`
- Support partial/full tender payment and existing tender methods
- Allocate to the selected invoice by default
- Create `collection_credit`, payment history row, and cash-shift movement for
  cash
- Never alter the original Pending payment row

### 4. Return Settlement

- Show original total, tender collected, remaining debt, prior returns, return
  value, debt reduction, and actual payout/credit due
- Automatically create `return_credit`
- Require payout methods only for the remaining credit due
- Create `refund_debit` for cash/card payout or `store_credit` when retained
- Update refund records with allocation details and audit events

### 5. Policy And Permissions

- Configure permitted refund methods by original tender type
- Default to original tender where practical
- `receivables.collect`, `receivables.view`, and
  `receivables.override_return_allocation` permissions
- Overrides require a manager-authorized actor and reason

## Delivery Order

1. Complete: add schema and append-only ledger foundation. Migration `043` adds
   the customer fields and receivable entry table.
2. Complete baseline: add SDL `purpose` normalization/validation and expose it
   in Configuration Studio. Full customer search/picker remains later.
3. Complete baseline: enforce customer resolution during Pending finalization,
   persist `invoices.customer_id`, and write `sale_debit` atomically.
4. Complete: add Invoice History balance collection with cash-shift integration.
   It writes a payment row, `collection_credit`, invoice projection, and cash
   movement in one transaction.
5. Complete: replace the tender-cap refund guard with return allocation
   settlement. Returns first create `return_credit` against outstanding debt;
   only the remaining amount is paid out and recorded as `refund_debit`.
6. Complete baseline: add Customer Accounts registry/detail with code/name/phone
   search, create/edit of lightweight customer data, open invoices, and the
   immutable receivables activity ledger. Account viewing uses `billing.view`;
   editing uses existing `products.manage` until dedicated receivables roles
   are introduced. Searchable Billing-field selection, dedicated permissions,
   customer statements, and store-credit allocation remain future iterations.

## Acceptance Tests

1. Cash-only sale can finalize without a customer.
2. Pending sale without configured/filled identity is blocked before completion.
3. Typed unique code resolves the intended customer; unknown value creates a
   minimal account only after operator confirmation.
4. Collection of 200.00 on an 815.00 debt leaves 615.00 open and records cash
   correctly in the shift.
5. A 500.00 return against 815.00 debt produces no payout and leaves 315.00.
6. A 1,200.00 return clears 815.00 debt and requires/creates exactly 385.00
   payout or store credit.
7. A full return produces exactly 1,000.00 payout after clearing 815.00 debt.
8. Prior collections and prior returns are included in every later calculation.
9. Manager allocation override is denied without permission and audited when
   allowed.
