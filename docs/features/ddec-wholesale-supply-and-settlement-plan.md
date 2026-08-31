# DDEC Wholesale Supply, Consignment, And Settlement Plan

Status: active feature plan
Started: 2026-08-06
Market profile: Dambulla Dedicated Economic Center (DDEC), wholesale produce

> **Scope rule:** This is a new product-feature plan. The closed rebuild plans
> remain historical references only. Build this module through explicit core
> services, database records, permissions, and reports; do not restore
> plugin-driven transaction behavior.

## Product Goal

Support a DDEC shop owner who receives high-volume produce from farmers and
suppliers, sells the goods to wholesale buyers at varying prices, and settles
with the supplier after sale. The system must support both normal purchases and
consignment, including partial payments, commission, transport and other
charges, weight loss, damage, returns, negotiated adjustments, printable A4
settlement reports, and editable Excel working papers.

The result must stay useful beyond DDEC. The reusable core concepts are
supplier, receiving, lot, stock movement, agreement, charge, payable, and
settlement. DDEC is a market profile that configures terms and fields, not a
special plugin that changes billing at runtime.

## Non-Negotiable Rules

1. A finalized sale, receipt, stock count, return, loss, settlement, or payment
   is append-only. Corrections create a new audited record; they never rewrite
   the historical record.
2. `products.stock_qty` is a fast projection. The inventory movement ledger is
   the source of truth.
3. Every received delivery becomes one or more identifiable inventory lots.
   A lot keeps its supplier, receipt, ownership model, terms, and measurement
   history even if the product name or default terms change later.
4. A normal purchase and a consignment delivery are different financial models.
   They must not be represented by the same generic metadata flag.
5. SDL may render optional DDEC fields and persist flexible metadata. SDL must
   not create arbitrary financial postings, settlement formulas, or database
   structures at transaction time.
6. An exported spreadsheet is a working copy, never the financial source of
   truth. Any approved change must be entered or imported as an audited POS
   adjustment before it affects a settlement.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Supplier | Farmer, trader, or other source that supplies goods. |
| Supply agreement | The commercial terms used for a supplier or receipt. |
| Purchase | The shop owns goods on receipt and may owe a supplier balance. |
| Consignment | The supplier owns goods until sold; the shop earns commission. |
| GRN | Goods Received Note: the factual receiving record for a delivery. |
| Lot | A traceable received quantity from a GRN line with its own terms. |
| Measurement event | A declared, bridge-weigh, sale, count, damage, or return weight. |
| Settlement | A reviewed statement of supplier amount due and payment outcome. |

## DDEC Business Flow

### Owned purchase

1. Create or select supplier.
2. Create GRN for the unloaded goods.
3. Record bag/package count and the known or measured kilogram weight.
4. Select purchase terms: fully paid, partially paid, or payable later.
5. Finalize GRN. It creates stock receipt movements and, when unpaid, a
   supplier payable balance.
6. Sales deduct stock from the received lot. Supplier payments reduce the
   payable balance.

### Consignment delivery

1. Create GRN and select `consignment` terms.
2. Snapshot the commission policy, settlement basis, and charge policy onto
   every received lot.
3. Sales allocate sold quantity and sale value to the lot.
4. The system accrues the supplier amount due from each eligible sale.
5. At the end of a day or selected period, create a draft settlement.
6. Review sale lines, loss/damage/return entries, charge deductions, and any
   manual adjustment with reason and approval.
7. Approve the settlement, then record full or partial supplier payment.

## Measurement And Variance Model

Produce cannot be handled safely as one static quantity. A DDEC delivery can
contain 100 bags expected at 20 kg each, then have a different truck-weighed
net weight and a lower sale/count weight after storage.

Each lot must retain these separate values:

| Measure | Example | Purpose |
| --- | --- | --- |
| Declared packages | 100 bags | Supplier delivery claim. |
| Expected conversion | 20 kg per bag | Operational estimate, never assumed fact. |
| Receiving net weight | Truck gross minus tare | Actual GRN stock basis when available. |
| Sold quantity/weight | Invoice allocations | What was sold to buyers. |
| Closing physical count | Remaining bags/kg | Counted reality. |
| Loss/damage/return | Reasoned movement | Explains a variance without changing history. |

The initial stock basis must be chosen deliberately on the GRN: declared,
measured net weight, or approved average. A later difference is recorded as a
stock adjustment with a reason such as moisture loss, spoilage, damage,
supplier return, or measurement correction. It is never silently applied by
changing the received weight.

## Financial Terms And Charges

Every GRN line snapshots its terms so future setup changes cannot rewrite an
old supplier deal.

### Consignment settlement formula

```text
Eligible sale value
- seller commission (normally 1.5% to 3%, or a fixed agreed rule)
- supplier-borne charges and approved deductions
+/- approved settlement adjustment
= supplier amount due
- supplier payments already recorded
= settlement balance
```

The settlement basis is an explicit agreement setting, initially one of:

- gross finalized sale value;
- net finalized sale value after sale discounts; or
- collected value only, for suppliers who are paid only after buyers pay.

The default for DDEC consignment is **net finalized sale value**, accrued when
the invoice is finalized. A supplier agreement can choose a different basis.

### Charge definitions

Administrators define named charge types, for example truck/lorry wage,
unloading, market levy, packaging, and spoilage recovery. Each definition has
a controlled treatment:

- deduct from supplier settlement;
- business expense only;
- add to owned-stock landed cost; or
- split by fixed amount, bags, kilograms, or sale value.

The first release should allow only these fixed treatments. Arbitrary formulas
or unreviewed SDL expressions must not affect supplier money.

## Core Data Model

The existing `suppliers` and `stock_movements` foundations are expanded rather
than bypassed.

| Record | Responsibility |
| --- | --- |
| `suppliers` | Supplier identity, contact details, active status, notes. |
| `supply_agreements` | Default ownership, commission, settlement basis, payment terms, and charge policy. |
| `goods_receipts` / `goods_receipt_lines` | GRN header and factual received lines. |
| `inventory_lots` | Supplier-owned traceable stock created from a GRN line. |
| `inventory_measurements` | Declared, weighbridge, count, loss, return, and correction observations. |
| `stock_movements` | Immutable stock ledger, extended with lot, business date, primary quantity, package quantity, and source document. |
| `lot_sale_allocations` | Links invoice/refund lines to lots and records sold quantity, kilograms, and sale value. |
| `stock_counts` / `stock_count_lines` | Physical stocktake and approved variance movements. |
| `supplier_payable_entries` | Immutable purchase/consignment debt, credit, charge, and payment ledger. |
| `supplier_settlements` / `supplier_settlement_lines` | Reviewed supplier sale summary and final calculated outcome. |
| `supplier_settlement_charges` | Applied charge rows with their terms snapshot. |
| `supplier_payments` | Full/partial payout records linked to settlement and cash/bank method. |

The inventory and payable ledgers must carry location/workstation business
context now, so a later multi-location or hosted tenant implementation can add
isolation without inventing a second financial model. The current deployment
remains one business per local POS installation.

## SDL Boundary

Use SDL for DDEC-specific display/input fields, such as vehicle number, farmer
reference, unloading note, scale ticket number, or destination area. Promote
fields to approved relational columns only when they are searched, filtered,
reconciled, or reported daily.

Examples that require core columns/tables:

- supplier and GRN number;
- receipt and lot identity;
- ownership model;
- business date;
- primary kilogram/package quantities;
- commission rate and monetary settlement amounts;
- charge type and charge amount.

Examples suitable for metadata/SDL:

- driver name;
- free-text delivery note;
- external scale ticket image reference;
- optional local classification.

## Reports And Output

### A4 documents

- GRN / receiving note.
- Supplier purchase balance statement.
- Consignment sold summary by supplier, lot, item, period, and buyer sale.
- Supplier settlement statement: gross/net sales, commission, charges,
  adjustments, payments, and balance due.
- Lot movement and weight-variance report.
- Daily wholesale sales, stock movement, and exception report.

### Thermal documents

- Compact GRN acknowledgement.
- Daily supplier sales-summary slip.
- Settlement payment voucher.
- Stock adjustment acknowledgement.

### Excel export

Generate an `.xlsx` workbook for each settlement and variance report with:

- a locked source-data sheet containing the exported ledger rows;
- a readable A4-print layout sheet;
- an editable working-adjustments sheet with formulas and notes; and
- a clearly marked draft/approved status.

Editable Excel values do not update POS records automatically. An operator must
enter approved adjustments in the settlement screen, or later use a controlled
import preview that shows every proposed change, validates it, requires a
reason/approver, and creates append-only adjustment rows.

## Permissions

Add a permission only with a protected UI and IPC action.

- `suppliers.view`, `suppliers.manage`
- `receiving.view`, `receiving.create`, `receiving.approve`
- `inventory.view`, `inventory.adjust`, `inventory.count`
- `supplier-settlements.view`, `supplier-settlements.create`,
  `supplier-settlements.approve`, `supplier-settlements.pay`
- `reports.view`, `reports.export`

Cash payments to suppliers must create an automatic cash-shift movement. Bank
payments are recorded as supplier payments but must not alter a cash drawer.

## Delivery Phases

### Phase 1: Inventory Truth And Supplier Foundation

Deliver in one substantial release:

- complete sale-side inventory movement posting at billing finalization;
- reverse sellable refund quantity through the same ledger;
- add supplier registry UI and supplier permissions;
- extend the stock movement ledger with business date and document references;
- add inventory lot and measurement records;
- implement stock adjustment and physical count flows with mandatory reasons;
- prevent negative stock only when the active product/market policy requires it.

Exit checks:

- a sale, refund, count, and adjustment each produces an immutable movement;
- product on-hand quantity reconciles to its movements;
- a return cannot restock a sale that never deducted stock;
- every manual variance identifies actor, date, reason, and affected lot.

### Phase 2: GRN And Owned Purchase Workflow

Deliver in one substantial release:

- GRN workspace with supplier, vehicle/reference, package and kilo measures;
- owned versus consignment selection;
- owned purchase cost, full/partial supplier payment, and payable balance;
- finalization creates lots, measurements, stock receipts, and payable entries;
- A4 GRN and thermal acknowledgement;
- searchable receiving history and supplier balance view.

Purchase Orders are intentionally deferred. Add them only after GRN use proves
that the market needs ordered-versus-received controls.

Exit checks:

- 100 bags at an approved measurement create one traceable lot;
- a partial supplier payment leaves a correct payable balance;
- no finalized GRN can be edited; correction uses a linked adjustment;
- GRN quantities reconcile to initial lot stock.

### Phase 3: Consignment Sale Allocation And Settlement

Deliver in one substantial release:

- supply agreements with commission and settlement-basis policies;
- deterministic lot allocation for sales, initially FIFO with explicit
  operator override and audit reason;
- supplier payable accruals from eligible consignment sales;
- loss, damage, supplier return, and negotiated adjustment workflows;
- draft, review, approval, full/partial payment, and reprintable settlement;
- automatic cash-shift movement for cash supplier payouts.

Exit checks:

- varying sale prices for the same onion lot calculate one correct sold total;
- commission and each charge have a visible calculation source;
- a damaged or moisture-loss adjustment affects stock and settlement only
  through approved records;
- payments cannot exceed the approved supplier settlement balance without a
  manager-authorized exception.

### Phase 4: Reporting, Excel, And Operational Hardening

Deliver in one substantial release:

- Reports workspace with date, supplier, lot, product, ownership, and status
  filters;
- sales, net-sales, cash/tender, customer receivables, stock movement, GRN,
  payable, consignment settlement, and variance reports;
- A4 print layouts and selected thermal summaries;
- Excel exports and controlled settlement-adjustment import preview;
- database-backed regression tests for repeated refund, concurrent sale,
  stock allocation, settlement, and payment limits;
- audit log views for high-risk adjustments and approvals.

Exit checks:

- an A4 settlement and Excel export reconcile to the same ledger totals;
- exported dates use business date while displaying recorded timestamp;
- a report total can be traced through settlement line, sale allocation, lot,
  GRN, and original invoice;
- a failed or duplicate action cannot create duplicate stock or payable rows.

## Explicit Deferrals

Do not include these in the first DDEC release:

- full accounting general ledger;
- supplier web portal;
- arbitrary formula engine for settlement calculations;
- multi-company cloud tenancy and cross-business data sharing;
- complex purchase-order approval chains;
- automated scale hardware integration beyond manual/recorded measurements.

## Decisions To Validate During Phase 1

- Whether a commission is calculated on gross sale, net sale, or cash collected
  for each supplier agreement.
- Whether a supplier may be paid before all buyer credit sales are collected.
- Which party bears each charge type by default.
- Whether the shop sells from a lot strictly FIFO or requires cashier-selected
  lot allocation for some products.
- Which measurement is the legal/operational stock basis when declared bag
  weight and truck net weight differ.

These are policy choices captured per supplier agreement or GRN snapshot. They
must not be hidden in code or changed retroactively for existing lots.
