# SDL Storage Contract

Status: active rebuild contract
Last validated against code: 2026-08-05

SDL describes business fields, but it does not get unrestricted control of the
database. Every segment has a storage intent that is compiled into the active
configuration revision before it can affect a transaction.

## Contract

```json
{
  "id": "vehicle_no",
  "scope": "bill",
  "kind": "input",
  "type": "text",
  "storage": {
    "mode": "indexed_attribute",
    "indexed": true
  }
}
```

Supported modes:

- `metadata`: flexible JSON storage. This is the backwards-compatible default.
- `indexed_attribute`: a future core-managed attribute projection for filtering
  and reporting. It is not an arbitrary tenant-created index.
- `column`: a core-approved relational column. The `target` must exist in the
  closed schema catalog.
- `child_table`: a future core-managed child structure. Its target name is
  validated and compiled into a migration request, never executed as raw SQL
  from SDL.

## Safety Rules

- Only input segments may use `column`, `indexed_attribute`, or `child_table`.
- A `column` target must match the segment scope and type in the core catalog.
- SDL may request a structure; only the core migration executor may apply it.
- Published revisions record the compiled storage plan used by the POS.

## Initial Approved Targets

| SDL field | Scope | Target |
| --- | --- | --- |
| `per_kilo` | `item` | `products.per_kilo` |
| `kilos` | `billing` | `invoice_items.kilos` |

These two legacy fields are mapped automatically while their saved SDL source
does not yet declare `storage`. New SDL should declare its intended storage
explicitly.

## Next Step

The next rebuild phase consumes this plan to create controlled additive schema
or projection migration requests and records their application status.
