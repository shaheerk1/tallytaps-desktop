# Cash Management Integration Checklist

Status: initial operational release in progress
Started: 2026-08-03

## Financial Contract

- [x] Cash shifts are separate from login sessions and are never deleted on a later sign-in.
- [x] Every shift has an immutable opening float, append-only cash movements, denomination counts, and a final reconciliation snapshot.
- [x] Cash sales and cash refunds post movements to the active shift in their own finalization transactions.
- [x] Cashiers submit a blind closing count before a manager can Z-close the shift.
- [x] A variance reason is required when the declared cash differs from expected cash.
- [x] Non-cash tenders remain outside physical drawer expected-cash calculations.

## Delivered

- [x] Drawer, shift, movement, count, count-line, and report database tables.
- [x] Cash permissions for cashier operations and manager closure.
- [x] Non-destructive workstation-session resume behavior.
- [x] Cash Management workspace for opening float, cash in/out, safe/bank drops, closing count, and final close.
- [x] Sales and cash refunds linked to the active cash shift.
- [x] Basic expected-versus-declared reconciliation and immutable Z snapshot.

## Next Iteration

- [x] Print formatted X and Z thermal shift summaries through the existing receipt printer path.
- [x] Archive every printed report run and add a dedicated report-history view.
- [ ] Daily store summary that aggregates closed shifts, sales, refunds, tender totals, and variances.
- [ ] Configurable denomination sets, currency, safe-drop thresholds, approval limits, and variance reason codes.
- [ ] Shared drawers, floating tills, cash transfers, and two-sided reconciliation.
- [ ] Database-backed concurrent-close and sale/refund cash-ledger regression tests.

## Operator Flow

1. Sign in and open a Cash Management shift with a counted opening float.
2. Finalize sales and refunds while the shift is open.
3. Record every manual cash change with an amount and reason.
4. Submit a physical denomination count at the end of the shift.
5. A manager enters a variance reason if needed and performs the final Z-close.

Never use logout as a financial close. A financial shift is closed only through
the reconciliation workflow.
