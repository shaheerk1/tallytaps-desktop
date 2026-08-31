# POS cloud archive and mobile billing

## Boundary

The POS remains the system of record and always commits business work to its local MySQL database first. Cloud synchronization is optional, asynchronous, and must never be awaited by billing, refund, cash, inventory, customer, cheque, business-day, or GRN transaction paths.

The server copy is a current-state reporting archive. It is not yet a physical or logical restore format. Stable local row IDs and the registered POS installation UUID form the cloud identity; `loc_code` and `mac_code` are uploaded as recorded business-origin values and are not treated as immutable configuration.

## Upgrade

- Migration `080_create_pos_cloud_archive_sync.sql` adds the singleton configuration, stream cursors, durable outbox, and per-table `cloud_sync_updated_at` columns.
- Migration `081_index_pos_cloud_archive_sources.sql` indexes high-volume scan cursors.
- Existing operational columns, keys, and workflows are unchanged.

Run `npm run db:migrate` on every installed POS database before deploying the new desktop package. Both migrations are recorded by `core_migrations` and are included in normal application startup migration handling.

## Included streams

Finalized invoices, invoice lines and payments; refunds; cash shifts/counts/movements/reports; stock movements, lots, measurements and finalized counts; parties, customer accounts and receivable entries; incoming and issued cheque lifecycle records; business days/events; and finalized or corrected GRNs/lines.

Held invoices, draft GRNs, supplier payments, supplier settlements, and supplier sales summaries are intentionally excluded from this release.

## Change handling

Each stream scans `(cloud_sync_updated_at, id)` and advances its own cursor in the same transaction that queues the serialized source row. An edit therefore creates a later ordered event with the same source key. The server replaces the older reporting state. Network retries are idempotent and acknowledged sequence gaps are reconciled before local outbox deletion.

## Runtime controls

Cloud backup uses the same host identity/API key configured for Field Transaction Inbox only to enroll the POS node. The returned POS-node key is encrypted with Electron `safeStorage`. Settings allow disabled/manual operation or automatic intervals, bounded records per request, and bounded requests per run. The scheduler is single-flight and uses retry backoff.

## Mobile bills

Each POS publishes its own complete item catalog. A phone selects that catalog, stores immutable item/price/charge snapshots in a standalone mobile bill, and routes it to all POS nodes or one selected node. The bill does not enter local POS sales, stock, cash, customer, or tax ledgers. The Field Transaction Inbox can view it and print a customer copy using this POS terminal's live receipt branding and printer configuration.

## Ordinary field-record delivery

Cash, card, stock, and note records default to all POS inboxes. A mobile device can instead select one or more POS archive nodes as its default destination. Registered desktop clients identify their POS node when fetching the field inbox, so selected records appear only at those destinations. The existing host-key endpoints and older clients remain compatible and receive records whose delivery scope is `all`.
