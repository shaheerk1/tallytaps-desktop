# POS Platform Phase Map

Status: closed historical phase map
Closed: 2026-08-06

> **AI development rule:** This map records the completed rebuild journey. It
> must not be used to restart old architecture phases or widen current feature
> work. Update only if a regression proves that a documented boundary is wrong;
> otherwise create a new feature-specific plan.

This document is intended for both humans and AI models working in this repo.
It explains:

- what the platform is,
- how it evolved,
- what phase it is in now,
- what the recommended next phases are,
- which architectural boundaries must stay stable,
- and how to keep updating this document as the app grows.

For the rebuild target and the keep/change/remove migration plan, also read:

- `docs/architecture/target-architecture-rebuild-charter.md`

If a future integration changes how billing, plugins, SDL, settings, or receipts
work, update this document in the same change.

## One-Sentence Summary

This repo is a desktop POS platform built on Angular + Electron + MySQL, with
a core-owned Segment Definition Language (SDL) for tenant/store configuration
and a plugin system reserved for bounded optional extensions.

## Current Architectural Answer

SDL authoring and execution should live in core, not inside plugins.

Recommended split:

- Core owns the parser, validator, evaluator, document, symbol table,
  compilation, and storage-plan application for SDL.
- Configuration Studio is the only SDL editor and `sdl_documents` is the
  only editable runtime source.
- Market defaults are passive JSON templates under `packages/core/sdl/templates`.
- Plugins may add bounded optional integrations, but cannot supply SDL forms,
  redefine core billing behavior, or run in the core transaction path.

That split is already reflected in the repo:

- Shared SDL implementation: `packages/shared/expressions/segment-language.js`
- Core document and compiler: `packages/core/sdl/`
- UI editor and preview: `apps/desktop/angular/src/app/configuration-studio/`

## Current Phase

Current phase: Phase 2, SDL-driven platform expansion.

More specifically, the project is no longer just a foundation shell. It now has:

- a working Electron shell,
- shared IPC contracts,
- billing and receipt flows,
- plugin discovery and lifecycle management,
- plugin settings persistence,
- a shared SDL engine,
- and a plugin migration path away from hard-coded business logic.

The repo is in a transition state:

- the core SDL engine exists and is shared,
- Configuration Studio is the only SDL authoring surface,
- market templates are saved database records,
- and the plugin host is limited to bounded optional extensions.

So the best label is:

- Phase 1: foundation, already completed
- Phase 2: operational platform with SDL extension, currently in progress
- Phase 3: multi-domain, core configuration and bounded extensions, planned

## Evolution So Far

### Phase 0: Foundation

Goal:

- prove the Electron + Angular shell could boot,
- expose a secure preload API,
- connect to MySQL,
- and establish plugin discovery.

What was introduced:

- Angular shell
- Electron main process
- preload bridge
- typed IPC contract
- database connection and migrations
- initial plugin registry/discovery

Evidence in repo:

- `docs/architecture/phase-1-foundation.md`
- `apps/desktop/electron/main/main.js`
- `apps/desktop/electron/preload/preload.js`
- `packages/shared/ipc/pos-api.ts`

### Phase 1: Operational Core

Goal:

- make the app usable as an actual POS desktop system.

What was added:

- login and workstation sessions
- catalog and item management
- billing screen and live bill persistence
- payment and finalization flow
- printing
- settings and admin screens
- plugin management
- roles and permissions

This phase made the app operational, but most domain behavior was still
embedded in core or in plugin-specific imperative code.

### Phase 2: SDL-Driven Expansion

Goal:

- move domain-specific behavior out of hand-coded plugins and into a shared,
  structured language the platform can understand.

What changed:

- SDL parser, validator, evaluator, and symbol table were added to the shared
  layer.
- Configuration Studio became the core authoring surface with JSON + form
  editing for a tenant/store SDL document.
- billing totals can now be computed authoritatively from the engine.
- runtime billing hooks are compiled from the tenant snapshot and are disabled
  by default, so core billing does not depend on plugin overrides unless the
  platform config explicitly allows them.
- SDL definitions are normalized and compiled into a core-owned snapshot after
  a Configuration Studio publish. Billing reads that snapshot directly.
- the platform snapshot has an explicit SDL effect-area allow-list for field
  rendering, validation, receipt layout, line calculation, and bill
  calculation.
- core infrastructure registers SDL field projection, calculation hooks, and
  finalization validation directly. The former Billing Engine, DDEC, and
  Supermarket SDL plugins have been retired; templates are named records saved
  from Configuration Studio.
- compiled SDL now publishes immutable configuration revisions with a checksum,
  tenant/store scope, normalized segments, resolved external symbols, and
  validation output; finalized invoices retain the governing revision ID.
- a source-linked refund module now creates separate immutable refund masters,
  refund items, payout records, and audited held drafts without changing the
  original sale.
- cash management now has a core drawer and shift ledger with opening floats,
  cash movements, denomination counts, blind close, final reconciliation, and
  printed X/Z report archive history.
- calculated billing segments may declare `setsLineGross: true` to provide the
  merchandise subtotal basis for a domain-specific pricing model such as
  rate-per-kilo, without teaching core billing about domain field names.
- produce-market was simplified toward reporting/materialization rather than
  owning the whole billing math.
- cross-plugin SDL references now require a plugin prefix; only local segment
  ids can be used bare.
- transaction-level `bill` header segments were added. They are input-only in
  this release, appear before item entry, persist through live/held/recalled
  bills, and finalize as `invoices.metadata.billHeader[pluginId][segmentId]`.
  They are deliberately isolated from line and grand-total calculations.
- a read-only Invoice Archive was added for finalized invoices. It filters by
  location, machine, billing date, and invoice/receipt number; it reprints the
  historical receipt document and supports manual PDF saving. Billing settings
  can optionally auto-save each completed UI bill as a PDF to a configured
  local backup folder. The export is best-effort and never rolls back a sale.

This is the current phase.

### Phase 3: Multi-Domain Authoring

Goal:

- make it possible for non-technical users to define field groups, equations,
  behaviors, and output placement through a guided UI.

Expected result:

- a user can create segments for billing line, totals, item master, and
  receipt output without needing to edit raw JSON first.
- the raw JSON remains available for advanced users and automation.
- the same SDL model powers both the form editor and the JSON view.

### Phase 4: Domain Packs and Ecosystem

Goal:

- let different business domains ship as plugin packs that mostly describe
  their data needs and rules.

Possible examples:

- produce market
- pharmacy
- restaurant
- retail
- repair center
- hotel

The platform provides common execution and validation; market templates supply
the initial segment set, and optional plugins are limited to real extensions.

## Current Status By Area

| Area | Status | Notes |
|---|---|---|
| Electron shell | Stable | Boots the Angular app and loads enabled plugins |
| Angular shell | Stable, still evolving | Handles navigation, shell state, and plugin views |
| IPC API | Stable, expanding | Typed bridge exists and is being extended carefully |
| Database migrations | Stable | Core migrations auto-run on boot |
| Billing UI | Active migration | Supports live bill edits, core SDL bill-header and line fields, payments, recall, printing |
| Invoice Archive | Initial operational release | Historical lookup, immutable detail view, thermal reprint, manual PDF export, and optional automatic PDF backup |
| Billing engine | Active migration | Core service computes totals with compiled SDL support |
| Refunds | Initial operational release | Source lookup, full/partial returns, historical pricing, held drafts, payouts, and refund receipts are implemented; reporting and ledger-backed inventory reversal remain next |
| Cash management | Initial operational release, extending toward report history | Drawer shifts, cash in/out, denomination counts, expected-versus-declared reconciliation, Z-close snapshots, and printed X/Z report archive history are implemented; daily store summary and multi-drawer workflows are next |
| SDL core | Active migration | Shared parser, validator, evaluator, symbol table, core-owned tenant/store documents, compiled snapshots, bounded effect areas, and audited storage-plan application records |
| Plugin settings | Implemented | Namespaced plugin-owned JSON settings stored in DB |
| Configuration Studio | Active | Core SDL form/JSON editor, validation, publish, and storage application status |
| Produce-market plugin | Partially migrated | Reporting/materialization reads core SDL-stamped metadata |
| Other plugins | Mixed | Some are still simple shells, some are already contributing routes/widgets/settings |

## Bill Header Segments

Use `scope: "bill"`, `kind: "input"` for values that apply once to the
whole transaction, such as a customer name, supplier name, purchase order, or
vehicle number. Do not use `scope: "billing"` for these values: that scope is
per line and is stored in `invoice_items.metadata`.

Recommended minimal example:

```json
{
  "id": "customer_name",
  "kind": "input",
  "type": "text",
  "label": "Customer",
  "scope": "bill",
  "order": 1,
  "sections": ["billing.header", "billing.receipt"]
}
```

Lifecycle rules:

- The Billing screen saves the values in `live_bill_contexts` as the cashier
  changes them; this allows a header to exist before the first item is added.
- Holding and recalling a bill restores the same header values.
- Finalization validates required visible header fields in the owning plugin
  and copies only declared values to the invoice metadata under the plugin id.
- Receipts display fields that opt into `billing.receipt`.
- Refunds read the original invoice metadata and show/print the same header
  values as historical source context; refund drafts never rewrite them.
- No new permission is introduced: these fields are protected by the existing
  `billing.create` authorization used by all live-bill mutations.

## Recommendation: Where SDL Should Live

The recommended architecture is:

### Core owns language semantics

The shared SDL engine should stay in the core/shared layer because it provides:

- one parser,
- one validator,
- one evaluator,
- one symbol table,
- one collision policy,
- one dependency cycle check,
- one preview model for the UI.

This avoids every plugin inventing its own mini-language or re-implementing the
same evaluation rules.

### Core owns configuration declarations

Configuration Studio owns the active tenant/store SDL document. It defines:

- segment scopes, kinds, equations, behavior, and placement,
- structural versus metadata storage,
- validation and preview before publish,
- and the immutable revision used by a finalized invoice.

This keeps a business configuration portable without assigning transaction
ownership to an executable plugin.

### Runtime owns one compiled snapshot

The runtime should:

- load the active core document revision,
- project its fields and calculations into billing,
- record the revision on finalized invoices,
- and never iterate market plugins to determine a sale amount.

### UI owns authoring experience

The UI should:

- show a friendly form for common editing,
- keep a raw JSON view available,
- validate live against the same SDL rules,
- and preview computed behavior using shared evaluation.

## Recommended Category Split

To keep the configuration understandable for non-technical users, split the
segment lists by editing surface and purpose, not by internal implementation.

Recommended categories:

1. Billing Inputs
2. Line Calculations
3. Bill Totals
4. Item Attributes

Why this split works:

- It matches how users think about the system.
- It keeps each list smaller.
- It avoids mixing inputs, calculations, bill totals, and item metadata.
- It makes it easier to explain where each segment affects the app.

Receipt output is a placement on a billing input or line calculation, not a
separate runtime scope. This keeps a segment's business meaning in one place
while allowing it to appear on the receipt, the items table, or both.

Recommended rules inside each category:

- keep input segments and calculated segments visually distinct,
- show the target sections as badges or chips,
- show dependency references inline,
- and make cross-plugin references obvious.

## Recommended Editor Pattern

Use a modal editor.

Best form:

- left side: visual form editor
- right side: JSON editor or live preview
- tabs or split view are both acceptable, but side-by-side is better for power
  users

Why modal works here:

- it keeps the list view clean,
- it supports iterative creation of one segment at a time,
- it is easier for non-technical users,
- and it still gives advanced users a raw JSON escape hatch.

Recommended edit flow:

1. User clicks Create Segment.
2. Modal opens on the Form tab.
3. JSON tab mirrors the form in real time.
4. Validation runs live.
5. Preview shows how the segment will behave.
6. Publish writes the normalized data to the core SDL document and compiles a
   new revision.

## Recommended Ownership Of Evaluation

For Phase B and beyond, evaluation remains core-owned and document-configured.

That means:

- the language evaluator is shared,
- Configuration Studio provides the segment definitions,
- the core compiler projects the approved snapshot,
- and the core engine executes the rules.

This is the best long-term path because it keeps calculation efficient and lets
independent segment addition scale without multiplying custom evaluators.

## Billing Amount Contract

Keep these three amounts distinct in every future plugin and report:

| Amount | Meaning | Source of truth |
|---|---|---|
| Gross / subtotal | Merchandise price after the domain's pricing basis, before discount, tax and line charges | Core base formula, or one calculated billing segment with `setsLineGross: true` |
| Net line total | The final stored total for each invoice line | Core base formula plus calculated billing segments with `affectsLineTotal: true` |
| Grand total | The amount payable for the bill | Sum of persisted line totals plus totals-scope segments with `affectsGrandTotal: true` |

For a weighted item, gross should normally be `price * kilos`, while the line
total can additionally include discount, tax, wage, packaging, or any other
configured line adjustment. The core now treats `kilos` and `per_kilo` as
promoted data shapes, so the transaction path can read them directly without
consulting plugin metadata for the basic weight decision.

Calculated billing segments are not necessarily cashier-facing totals. Use
`showInTotals: false` for internal helpers such as `gross`, `net`, and
`net_adjust`; leave it enabled for useful running summaries such as Wage or
Bags. The historical default is `true` for backwards compatibility.

For screen placement, an omitted `sections` property uses the historical
default. An explicit `"sections": []` means the segment is internal only: it
may affect a calculation but is not rendered in the line table or receipt.

## Namespace And Collision Rule

Use bare ids inside the active SDL document. References to optional extension
fields must be explicitly provider-prefixed. Core SDL must not depend on an
optional extension field for a transaction to be valid.

## Current Plugin Story

### Core SDL and market templates

Current role:

- Configuration Studio is the only SDL authoring surface.
- `sdl_documents` and compiled revisions are the only runtime source.
- DDEC produce and supermarket defaults are passive templates under
  `packages/core/sdl/templates`.

Important rule:

- a tenant selects and publishes one reviewed SDL document; templates never
  activate, register hooks, or alter a transaction by themselves.

### produce-market

Current role:

- reporting/materialization plugin
- uses data stamped by core SDL
- serves domain reports and option lookup

Important idea:

- it is no longer the primary owner of the billing math.
- it should remain a domain pack that proves the shared SDL approach works in a
  real scenario.

### other domain plugins

Current role:

- mostly structural or partially implemented

Future role:

- each remains a bounded optional extension without defining its own SDL
  segment set or calculation runtime.

## Refund Transaction Contract

Refunds are separate financial documents, not negative edits to invoices.

- A refund links every line to an original `invoice_items` row.
- Completion locks the source rows and rechecks previously completed refunds,
  preventing two cashiers from refunding more than was sold.
- The first release uses the source line's recorded money values and prorates
  them for partial returns. It deliberately does not re-run current SDL
  settings, because configuration may have changed after the sale.
- Plugin metadata is copied and visible to the operator, but only the source
  quantity/kilos and stock disposition are editable until segments declare a
  refund-specific policy.
- Refund payouts are tender-only and cannot exceed the tender amount collected
  on the original sale. Customer-credit settlement requires a ledger first.
- The return's stock disposition is saved now. Stock quantity must not be
  increased until sale finalization and refunds share one inventory ledger;
  otherwise a refund would add stock that the original sale never deducted.

Read the implementation record before extending this workflow:

- `docs/architecture/refund-module-integration.md`

## Future Architecture Changes Likely Needed

To reach the next phases cleanly, the following structural changes are likely
needed.

### 1. Optional segment catalog model

The current UI derives its four category lists from the stable SDL `scope` +
`kind` pair, so no new database model is needed yet. Add a first-class segment
catalog only if future domain packs need their own groups, templates, ownership
metadata, or a review/approval workflow. Do not persist duplicate category
state while the derived categories are sufficient.

### 2. Richer editor state model

The current plugin-host editor already supports form building and segment
building, but the next step is a more deliberate state machine:

- create
- duplicate
- edit
- preview
- validate
- save

### 3. Better symbol browser

For non-technical users, reference insertion should become a guided browser:

- base symbols
- current plugin segments
- cross-plugin symbols

This is especially important once more than one domain pack starts using SDL
heavily.

### 4. Stronger dependency visualization

As segment graphs grow, the UI should show:

- what references what,
- what is computed from what,
- and where collisions or cycles would happen.

### 5. Formal phase-specific migrations

Because the platform is evolving iteratively, some migrations should be tied to
phases:

- DB schema migrations
- plugin manifest migrations
- settings schema migrations
- saved segment data migrations

## How To Keep This Document Updated

Update this document whenever any of the following change:

- SDL syntax or evaluation rules
- plugin settings schema
- segment scope definitions
- billing totals behavior
- plugin runtime lifecycle
- produce-market reporting rules
- new domain plugin patterns
- major UI editing workflow changes
- namespace or reference rules

Recommended update checklist:

1. Update the phase table.
2. Update the "Current Status By Area" table.
3. Add a short note under "Current Plugin Story" if a plugin changed role.
4. Add any new architectural decision under "Future Architecture Changes."
5. Update the validation date at the top.

## Practical Reading Order For AI Models

When a model loads this repo, the best reading order is:

1. `docs/architecture/living-phase-map.md`
2. `packages/shared/ipc/pos-api.ts`
3. `packages/shared/expressions/segment-language.js`
4. `apps/desktop/electron/main/service-container.js`
5. `apps/desktop/electron/ipc/ipc-registry.js`
6. `packages/core/billing/billing-engine.service.js`
7. `packages/core/refunds/refund.service.js`
8. `packages/database/repositories/refund.repository.js`
9. `docs/architecture/refund-module-integration.md`
10. `apps/desktop/angular/src/app/plugin-host/plugin-host.component.ts`
11. `apps/desktop/angular/src/app/billing/billing.component.ts`

That order gives the model the platform story before the implementation details.

## Direct Answers To The Open Questions

### Is SDL better in the core or inside each plugin?

Core is the better place for the SDL engine. Plugins should declare behavior,
not re-implement the evaluator.

### Should categories be split?

Yes. Split by user-facing purpose:

- billing line
- billing totals
- item attributes
- receipt output

### Should create/edit be modal?

Yes. A modal editor is the best default, with form and JSON views side by side
or tabbed.

### Who should own evaluation?

The core engine should own evaluation. Plugins should own declarations and
hooks.

### How do we validate the multi-plugin pattern?

Use the shared SDL engine, use plugin-prefixed cross-plugin references, and let
each plugin contribute only its own segment definitions and hooks.

## Current Verdict

The app is in the right place to evolve from a configurable POS platform into a
domain-pack platform.

What is already right:

- shared SDL exists,
- plugin settings exist,
- billing is already hook-driven,
- and the UI can be made more approachable without redesigning the whole
  platform.

What still needs work:

- richer segment catalog UX,
- stronger visualization of dependencies,
- tighter phase documentation,
- and a consistent pattern for every future plugin pack.

That means the current direction is good, but the system needs a clearer
authoring layer before it becomes truly non-technical-user friendly.
