# Rebuild Execution Plan

Status: closed historical execution plan
Closed: 2026-08-06

> **AI development rule:** This rebuild plan is complete. Treat it as a historical
> decision record, not an active backlog. Do not reopen or continue its phases
> while building new features unless a verified regression directly affects the
> core SDL/configuration boundary. Create a dedicated feature plan for reporting
> or any new product work instead.

This plan turns the rebuild charter into an iteration sequence that a human or
AI can check at any time.

Use it with:

- `docs/architecture/living-phase-map.md` for the current system state
- `docs/architecture/target-architecture-rebuild-charter.md` for the target
  architecture and boundary rules

## Working Rule

Do not make the rebuild a rewrite project.
Move the system in measured phases so the app keeps working while the target
shape gets stricter.

## Phase 0: Establish the New Boundary

Goal:

- introduce a first-class platform configuration surface
- stop treating plugin-driven behavior as the only configuration model
- keep the current app behavior unchanged

Deliverables:

- `platform-config` core service
- IPC exposure for reading and updating the compiled tenant config snapshot
- stable defaults for the new platform config layer
- documentation of the config boundary

Exit check:

- the app can read a bounded platform config object without consulting every
  plugin at runtime

## Phase 1: Stabilize Core Tables

Goal:

- identify high-value JSON fields that should become relational
- define the first promoted columns or child tables

Deliverables:

- schema plan for billing, invoice, refund, cash, and catalog data
- explicit list of fields that remain metadata only
- first projection table for reporting-heavy data

Exit check:

- common reporting or lookup paths no longer require metadata spelunking

## Phase 2: Constrain SDL

Goal:

- keep the SDL editor
- make SDL compile into a tenant snapshot instead of acting as a live runtime
  override system

Deliverables:

- SDL normalization snapshot
- allowed-areas list for SDL effects
- clear rule for when data is structural vs metadata

Exit check:

- a transaction path can point to one compiled SDL/config snapshot

## Phase 3: Separate Core SDL From Optional Extensions

Goal:

- keep optional extensions bounded
- remove plugin ownership of SDL and core transactions

Deliverables:

- core-owned Configuration Studio and document contract
- passive market JSON templates, not executable configuration packs
- explicit plugin-to-core extension points for genuinely optional behavior

Exit check:

- a tenant can publish a market configuration without activating a billing
  plugin or making the core transaction path ambiguous

## Deferred: Shared-Backend Multi-Tenant SaaS

Decision: not planned for the current deployment model. Each POS installation
serves one business, with store/workstation/user scoping inside that business.
The existing tenant/store fields on SDL documents and revisions are retained as
future-ready groundwork only. Do not add tenant columns across all business
tables until the product moves to a shared cloud backend.

Goal:

- make support, upgrades, reporting, and auditing predictable across tenants

Deliverables:

- tenant-aware reporting
- durable audit trails
- config versioning and migration markers
- clear operator-facing explanations for money movement

Exit check:

- support can explain any financial action without reading plugin internals

## Architecture Cutover Status

The agreed SDL/plugin architecture cutover is complete: SDL is core-owned,
compiled before use, bounded by effect areas, versioned on invoices, and edited
only through Configuration Studio. Market templates are named database records,
not plugins or runtime files. Plugins are optional bounded extensions only.

Immediate next tasks:

1. Preserve the closed SDL boundary: Configuration Studio is the only authoring
   path and templates are staged before publishing.
2. Return to feature work and fix operational issues as they are found.
3. Promote financial and reporting fields out of JSON only when a concrete
   query, report, or reconciliation need justifies it.
4. Revisit shared-backend tenant isolation only when cloud SaaS becomes a real
   product requirement.

## Next Financial Feature

Implement the approved customer receivables and return-settlement design in
`docs/architecture/customer-receivables-and-return-settlement-plan.md` before
adding further Pending, refund, or customer-loan behavior.

## Progress Check

At the end of every change set, answer these questions:

- Did this change reduce or increase runtime plugin dependence?
- Did this move any important field toward a queryable structure?
- Did this make the core flow easier to explain?
- Did this keep the current app operational?
