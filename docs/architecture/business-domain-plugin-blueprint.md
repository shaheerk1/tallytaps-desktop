# SDL Market Template Blueprint

Status: superseded historical contract
Superseded: 2026-09-07
Last validated against code: 2026-08-05

> **AI development rule:** The SDL and plugin systems this document describes
> were removed from the code by migrations 041, 042, and 057. The matching
> source folders (`packages/core/sdl`, `packages/core/plugins`,
> `packages/core/platform-config`, `packages/shared/expressions`, and the
> Angular `configuration-studio` / `plugin-host` / `plugin-manager` folders)
> are empty. Read this only as history. Build new behavior as explicit core
> services, tables, permissions, and reports.

Business setup is core SDL configuration, not a billing plugin. Use this guide
to add a reusable market starting point without introducing a runtime hook,
plugin route, or per-transaction plugin dependency.

## File Shape

Create one JSON file under `packages/core/sdl/templates/`:

```text
packages/core/sdl/templates/<market-name>.json
```

The file contains a `schemaVersion` and a `segments` array. It is passive
source material: nothing discovers, activates, or automatically applies it.

## Apply Flow

1. Select the appropriate template for a tenant/store.
2. Copy its segments into Configuration Studio.
3. Make operator-approved changes in the form or JSON editor.
4. Validate and publish.
5. Core stores the source in `sdl_documents`, compiles an immutable
   `config_revisions` record, and applies its storage plan.

The published document is always the runtime source. Never use a template file
or `plugin_settings` as a runtime fallback.

## Segment Rules

- Item inputs describe product facts, such as `per_kilo` or `wage_amount`.
- Billing inputs collect per-line sale values, such as `kilos`.
- Calculated billing segments derive values from the line context.
- One calculated billing segment may set `setsLineGross: true`.
- A calculated segment with `affectsLineTotal: true` changes the stored line
  amount.
- Totals-scope segments may use `affectsGrandTotal: true`.
- Use `showInTotals: false` and `sections: []` for internal helpers.

For a weighted market, use this contract:

```text
gross       = price * effective quantity      (setsLineGross)
net         = gross - discount + tax + charges
net_adjust  = net - core base line total      (affectsLineTotal)
```

## Storage Rule

Use SDL storage declarations for data that needs fast filtering or reporting.
Keep only flexible, low-query-frequency values in metadata. The storage plan
is reviewed and applied when Configuration Studio publishes the document.

## Extension Boundary

Create a plugin only for an optional capability that SDL cannot express, such
as a hardware integration, external service adapter, specialized report, or
post-finalization projection. A plugin must not define `segment-builder`, own
billing calculations, or provide an alternate SDL source.
