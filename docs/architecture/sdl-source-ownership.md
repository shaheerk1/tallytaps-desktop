# SDL Source Ownership

Status: active rebuild contract
Last validated against code: 2026-08-05

The editable SDL source is owned by core configuration, not by a plugin.

## Source Of Truth

- Working document: `sdl_documents`, one row per tenant/store.
- Immutable compiled history: `config_revisions`.
- Storage application audit: `sdl_storage_applications`.

`sdl_documents.source_json` retains the editable JSON form. Its
`source_version` changes only when source content changes. A compiled revision
records the document ID and source version that produced it.

## Runtime Rule

1. Configuration Studio is the only SDL editor and `sdl_documents` is the
   only editable runtime source.
2. Compilation reads the core document and publishes an immutable revision.
3. SDL market templates are passive JSON files under `packages/core/sdl/templates`.
4. Former plugin records may remain disabled for lifecycle history, but plugin
   settings and plugin manifests are not a fallback SDL source.

New values use the `core-sdl` metadata namespace. `billing-engine` is read
only as a compatibility fallback for older invoice and live-bill values; it
does not imply a plugin dependency or activation path.
