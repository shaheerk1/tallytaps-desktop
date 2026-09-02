# Customer Advance Integration Checklist

Status: initial operational release complete
Started: 2026-09-02

Money a customer hands over before there is a bill is a **liability the shop
holds**, not income and not a negative receivable. This document is the
implementation record for that model. Update it in the same change as any later
advance work.

## Why It Is Not Cash In

Recording a prepayment as a generic `cash_in` drawer movement loses the only
facts that matter later: whose money it is, how much of it is left, and which
bill consumed it. On a different day, at a different terminal, the cashier
taking the remaining payment has no way to see the balance. So an advance gets
its own numbered document and its own append-only ledger, and the drawer sees
only a dedicated `customer_advance_cash` movement.

Accounting-wise this matches the ordinary treatment of a customer prepayment: a
contract liability recognised on receipt and released when the goods are
supplied or the money is returned.

## Core Rules

1. An advance requires a real linked customer account. It never requires credit
   to be enabled — the customer is providing money, not borrowing it.
2. Receiving an advance creates no sale, no invoice and no revenue.
3. Available balance is always derived:
   `received + restored − applied − refunded`. There is no editable balance
   column anywhere.
4. An advance is spent only by an explicit operator action. Outstanding
   invoices never consume it automatically.
5. Redeeming an advance moves one liability onto a bill. It creates an invoice
   payment and **no** cash movement — the cash entered the drawer when the
   advance was received.
6. Advance money is never returned as change. It settles only the amount the
   other tenders leave unpaid.
7. Returning unused advance money is its own audited document with its own
   cash/bank outflow.
8. Corrections use reversal entries. Nothing is deleted or rewritten.

## Data Model

| Table | Responsibility |
| --- | --- |
| `customer_advance_receipts` | The numbered `ADV-…` receipt: customer, business day, origin, original amount, reason. |
| `customer_advance_payments` | How the advance was collected (cash, card), one row per tender line. |
| `customer_advance_refunds` | The numbered `AVR-…` voucher returning unused money. |
| `customer_advance_entries` | The append-only ledger: `receipt_credit`, `application_debit`, `refund_debit`, `reversal_debit`, `restore_credit`. |
| `invoice_advance_allocations` | Exactly how much of which receipt each invoice payment consumed. |

Migrations `086_create_customer_advance_ledger.sql` and
`087_link_advance_restorations_to_invoice_allocations.sql` create these, add the
`customer_advance_cash` / `customer_advance_refund_cash` drawer movement types,
and register the system `advance` payment mode.
`088_rename_advance_payment_mode.sql` renames that mode to `Advance`, which is
the label the tender tile and the printed receipt show.

Receipts are consumed oldest-first under `FOR UPDATE`, so two terminals cannot
spend the same balance.

## Location Scope

An advance is spendable only at the `loc_code` that received it. The cloud
server is a reporting archive, not a real-time transactional authority, so a
balance cannot safely be spendable from several independently offline
terminals. Cross-location redemption needs an online reservation service and is
deliberately deferred.

## Operator Flow

1. Open Customer Accounts and select the customer.
2. **Receive advance** — amount, method, reason. A numbered advance receipt
   prints, and cash lands in the active shift as `customer_advance_cash`.
3. Later, on a bill for that customer, choose the **Advance** tender. The
   panel shows the balance held at this location and caps the entry at the
   remaining bill balance.
4. On an already-outstanding bill, Invoice Archive → *Collect outstanding
   balance* offers **Advance** whenever the linked customer holds one.
5. **Refund unused** returns money that will not be used, as its own voucher
   and drawer outflow.

## Delivered

- [x] Receipt, payment, refund, entry and allocation tables with origin
      identity, business-day binding and cloud-archive columns.
- [x] `customer-advances.view` / `.create` / `.refund` permissions, granted
      from the matching customer and receivables permissions.
- [x] Repository with derived balances, oldest-first locked allocation, and
      transactional receive/apply/restore/refund.
- [x] Service-level shift, tender and availability validation.
- [x] IPC contracts and preload bridge for balance, summary, receive, refund.
- [x] Customer Accounts advance panel: balance metric, receive, refund unused,
      and the recent entry ledger.
- [x] Numbered thermal advance receipt and refund voucher.
- [x] `Advance` tender in bill completion, capped at both the balance held
      and the amount other tenders leave unpaid.
- [x] `Advance` settlement of an outstanding balance from Invoice Archive.
- [x] Refund payout that restores the advance an invoice originally consumed,
      bounded by what that invoice actually took.
- [x] Invoices that consumed advance money cannot be reassigned to another
      customer.
- [x] All five tables in the cloud archive streams.
- [x] Ledger invariants in `npm run verify:ddec-ledger` for over-application,
      receipt/payment drift, unlinked applications and over-restoration.
- [x] Service regression coverage in
      `tools/e2e-verify/customer-advance-settlement.spec.js`.

## Deferred Rules

- **Cheque advances** are rejected until clearance tracking exists. A cheque
  that has not cleared is not money the customer can spend.
- **Cross-location redemption** needs an online reservation/authorization
  service; balances stay location-scoped.
- **Expiry dates** on an advance are not modelled. Add them with a policy and a
  reversal workflow, never as silent forfeiture.
- **Manager reversal of a posted advance** uses `reversal_debit`, which the
  ledger supports but no screen writes yet.
- **Reporting**: advances do not yet appear in the daily store summary as a
  separate liability movement.

## Boundaries To Keep

- Never let an advance flow through `customer_receivable_entries`. That ledger
  treats credits as reducing debt, so an advance there would read as a
  misleading negative receivable.
- Never derive the balance from anything but the entries.
- Never create a cash movement when an advance is *applied*; only when it is
  *received* or *refunded*.
