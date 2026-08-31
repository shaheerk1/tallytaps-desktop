# Phase 1 Foundation

This folder is the clean starting point for the modular POS platform.

Implemented in this first step:

- Angular shell with a dashboard route.
- Electron main process bootstrap.
- Secure preload bridge exposed as `window.posApi`.
- Typed IPC contract in `packages/shared/ipc/pos-api.ts`.
- IPC registry with wrapped success/error responses.
- MySQL connection module using `mysql2/promise`.
- Core health check handler: `core.health.check`.
- Database health check handler: `database.health.check`.
- Core migration runner with status and run-pending commands.
- Plugin registry placeholder.
- Plugin manifest validation and disk discovery from `plugins/*/plugin.json`.
- Empty event bus placeholder.

Business modules are intentionally not implemented yet.
