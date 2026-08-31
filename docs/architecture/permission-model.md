# Permission Model

The role screen represents only live product capabilities. A permission must be both registered as a core capability (or supplied by an installed plugin) and enforced at the backend IPC boundary before it is presented to administrators.

## Current core permissions

- `billing.view`, `billing.create`
- `refund.view`, `refund.create`
- `cash.shift.view`, `cash.shift.open`, `cash.movement.create`, `cash.count.create`, `cash.shift.blindClose`, `cash.shift.close`
- `products.manage`
- `customers.view`, `customers.manage`
- `receivables.view`, `receivables.collect`
- `reports.view`, `settings.manage`, `users.manage`, `plugins.manage`

The Emoji plugin may add its own permission while it is installed. Retired plugins and their permissions must never be left visible in roles.

## Customer and receivables boundaries

- `customers.view`: search and select a customer during billing.
- `customers.manage`: create or edit customer contact details and status.
- `receivables.view`: view account balances, ledger entries, and statements.
- `receivables.collect`: collect a pending invoice balance. This is separate from creating a new bill.

Automatic customer creation from an SDL `customer_identifier` happens as part of `billing.create`; it does not grant a cashier general customer-record editing rights.

## Role defaults

A cashier receives the permissions needed to sell, open and operate a cash shift, create refunds, search customers, view receivable accounts, and collect balances. Customer record editing, configuration, user administration, and plugin management remain management responsibilities.

## Future additions

Add a permission only when its user-facing action and backend authorization exist. For example, a future manager-only receivable write-off workflow should introduce `receivables.adjust` together with its UI, audit record, and IPC guard. Do not pre-create permission checkboxes for planned features.
