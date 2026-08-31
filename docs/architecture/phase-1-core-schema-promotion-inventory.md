# Phase 1 Core Schema Promotion Inventory

Status: working inventory
Last validated against code: 2026-08-05

This document lists the first data shapes that should be promoted out of loose
JSON usage and into stable relational structures during the rebuild.

It is intentionally conservative.
Do not promote everything. Promote only what is operationally important,
frequently queried, or needed to keep the POS explainable at scale.

Use this alongside:

- `docs/architecture/rebuild-execution-plan.md`
- `docs/architecture/target-architecture-rebuild-charter.md`

## Promotion Rule

Promote a field when it becomes one or more of the following:

- frequently filtered
- frequently reported
- used in accounting or reconciliation
- required for audit explanation
- required for indexing or joins
- repeatedly recomputed from metadata in many places

Leave a field in metadata when it is:

- display-only
- rare or experimental
- tenant-specific but low-value
- needed only by a narrow plugin or domain pack

## First Candidates

### Billing line and bill header data

Current home:

- `invoice_items.metadata`
- `live_bill_contexts.metadata`
- `invoices.metadata.billHeader`

Promote when the data becomes stable across tenants:

- customer / supplier / vehicle identifiers
- transaction-level header fields used in reports
- weighted-sale basis values that are always queried, such as kilo/weight
- any field that support or reporting staff must search by every day

Suggested relational shapes:

- `invoice_headers`
- `invoice_item_attributes`
- `live_bill_headers`

### Product master data

Current home:

- `products.metadata`

Promote when the data affects catalog search, filtering, pricing, or stock:

- category-like attributes used in filters
- unit and packaging data that drive sale behavior
- flags that affect billing or item entry
- any attribute that users treat as a real product column

Suggested relational shapes:

- real columns on `products`
- or a product-attributes child table for rare extensions

Already promoted in this rebuild slice:

- `category` is now treated as a first-class column and backfilled from legacy
  metadata for existing rows.
- sample products now seed category directly into the relational field instead
  of hiding it in JSON.
- `per_kilo` is now treated as a first-class product column and is backfilled
  from legacy product metadata for existing rows.
- `kilos` is now a first-class invoice-line column and is backfilled from
  legacy line metadata for existing rows.

### Refund source metadata

Current home:

- `refunds.metadata`
- `refund_items.metadata`

Promote when the data affects return reconciliation or reporting:

- source invoice item references
- stock disposition
- refund reason codes
- quantity or weight fields used in reporting

Suggested relational shapes:

- explicit source reference columns
- refund reason table or code column
- return disposition columns on refund items

### Cash shift metadata

Current home:

- `cash_shifts.metadata`
- `cash_movements.metadata`

Promote when the values drive reconciliation or report summaries:

- movement reason codes
- approval or variance classifications
- counts or denominations that are routinely reported

Suggested relational shapes:

- movement code columns
- count snapshot tables
- reconciliation summary columns

### Platform configuration

Current home:

- `system_settings.code = 'platform'`

Keep this as configuration, not transactional truth.

The platform config is meant to control rebuild behavior, SDL mode, metadata
policy, and tenant pack selection. It should stay readable and versioned, but it
does not need to become a heavy schema of its own yet.

## Keep In Metadata For Now

These should remain flexible until they prove themselves operationally:

- receipt decoration fields
- low-volume custom UI fields
- tenant notes and annotations
- plugin-specific display extras
- export-only or rarely queried detail

## Suggested First Table Work

If we only promote a small batch first, do this order:

1. Add explicit invoice header columns or a small header table for stable
   transaction-level values.
2. Add product columns for any catalog fields that already drive lookup or sale
   behavior.
3. Add explicit refund source and disposition columns.
4. Add cash movement reason / code columns where reconciliation uses them.
5. Promote weighted line measures such as `kilos` out of line metadata.
6. Leave plugin-specific display extras in metadata until they become common.

## Checkpoint For Phase 1 Completion

Phase 1 is ready to move on when:

- the team can name the fields that are still safely metadata-only
- the team can name the fields that must be columns
- common lookup/reporting paths no longer depend on decoding arbitrary JSON
- the database shape explains the business, not just the UI
