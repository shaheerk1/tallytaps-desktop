import type { PosApi } from '../../../../packages/shared/ipc/pos-api';

export {};

declare global {
  interface Window {
    posApi?: PosApi;
  }
}
