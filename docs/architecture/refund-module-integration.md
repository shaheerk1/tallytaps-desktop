# Refund Module Integration Checklist

Status: initial operational release complete; reporting and inventory-ledger integration remain planned
Started: 2026-08-03

This checklist is the implementation record for the source-linked refund module.
Update it in the same change as each completed integration step.

## Design Decisions

- [x] Refunds are immutable, linked documents; finalized invoices are never edited.
- [x] Full refunds copy every still-refundable source item.
- [x] Partial refunds may select only source invoice items and may not exceed previously unrefunded quantity, kilos, or value.
- [x] Historical source line values are used as the calculation baseline so plugin setting changes cannot reprice a return.
- [x] Refunds have their own per-workstation/day sequence and payment records.
- [x] Held and abandoned refunds remain auditable as drafts rather than unlinked transaction rows.
- [x] Returned stock has an explicit sellable/damaged/waste disposition, retained with each return line.

## Delivery Checklist

- [x] Create refund sequences, drafts, masters, items, payments, and audit migrations.
- [x] Add refund permissions and default administrator grants.
- [x] Add repository support for lookup, draft lifecycle, and transactional finalization.
- [x] Add a refund service with source-limit and payment validation.
- [x] Expose refund IPC contracts through the preload bridge.
- [x] Add the refund workspace, lookup, full/partial selection, hold, clear, and completion UI.
- [x] Reuse active plugin field display and source metadata in refund lines.
- [x] Print a dedicated refund receipt linked to the original invoice.
- [x] Add service-level regression coverage for weighted partial refunds and payment validation.
- [ ] Add database-backed repeat-refund and concurrent-limit coverage.
- [ ] Add refund reporting effects to net sales and inventory movement reports.
- [ ] Connect stock restocking to the sale-side inventory ledger, so a return can only reverse a recorded sale deduction.

## Deferred Rules

- Customer-credit refunds need a ledger before a cash payout is allowed for an unpaid balance.
- Plugin-specific fixed-charge policies need an explicit SDL `refundPolicy`; the initial release prorates source values.
- The first release displays and preserves source plugin metadata. Only the source quantity/kilos and stock disposition are editable; arbitrary plugin values stay read-only until each segment declares an explicit refund policy.
- Refund approval thresholds and reason catalogs will be configurable after the safe core flow is live.
