import { Injectable } from '@angular/core';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { Subscription } from 'rxjs';

/**
 * Opening one screen from another, carrying what it should show.
 *
 * A link is a small, typed request -- "open the invoice archive at this bill",
 * "start a new bill copied from that one" -- carried as query parameters, so it
 * survives a reload and the back button, and every screen reads its links the
 * same way.
 *
 * A link is applied once. The receiving screen calls `consume` after acting on
 * it, so reloading the screen does not repeat an action such as copying a bill.
 *
 * To add a link:
 *   1. describe its fields in a `...Link` type and its parameter names in PARAMS;
 *   2. add an `open...` method that writes them;
 *   3. add a `read...Link` function, and call `onLink` with it in the receiving
 *      screen's ngOnInit.
 * Parameter names live here and nowhere else.
 */

/** Show one bill in the invoice archive. Filters the link does not set are cleared. */
export type InvoiceArchiveLink = {
  invoiceId: number;
  invoiceNumber?: string;
  locCode?: string;
  macCode?: string;
  txnDate?: string | Date;
  /** Include bills returned in full, so a reversed bill can still be found. */
  showReturned?: boolean;
};

/** Start a new, editable bill from a finished one. */
export type BillingCopyLink = {
  copyFromInvoiceId: number;
};

/**
 * Open Supplier Receiving at one of its areas: a new GRN, a new supplier
 * statement, or the lot codes under Stock control.
 */
export type ReceivingLink = {
  open: 'new-grn' | 'new-statement' | 'lot-codes' | 'send-out' | 'adjust-count';
  /** With 'lot-codes': open this lot's own summary rather than the list. */
  lotId?: number;
};

/**
 * Where a screen was opened from, so it can offer a way back.
 *
 * Held in memory rather than in the address, because a link is consumed as
 * soon as it is applied and the way back has to outlive it. It is the one
 * link the user walks in both directions, so the return trip carries its own
 * link -- the lot summary reopens at the lot, not at the list.
 */
export type ReturnTarget = {
  /** Where to go, as a link of its own. */
  url: string;
  queryParams?: Record<string, string | number>;
  /** What to call it on the button: "Back to lot BONS". */
  label: string;
};

const RECEIVING_TARGETS: ReceivingLink['open'][] = ['new-grn', 'new-statement', 'lot-codes', 'send-out', 'adjust-count'];

const PARAMS = {
  invoiceArchive: {
    invoiceId: 'invoice', invoiceNumber: 'number', locCode: 'loc', macCode: 'mac', txnDate: 'date', showReturned: 'returned'
  },
  billingCopy: {
    copyFromInvoiceId: 'copyFrom'
  },
  receiving: {
    open: 'open', lotId: 'lot'
  }
} as const;

/** Every parameter any link may set; `consume` removes exactly these. */
const ALL_LINK_PARAMS: string[] = Object.values(PARAMS).flatMap((group) => Object.values(group));

@Injectable({ providedIn: 'root' })
export class PageLinksService {
  constructor(private router: Router) {}

  /** Where the screen now opening should offer to go back to, if anywhere. */
  private pendingReturn: ReturnTarget | null = null;

  get returnTarget(): ReturnTarget | null { return this.pendingReturn; }

  /** Takes the offered way back, and spends it: it is good for one trip. */
  goBack(): Promise<boolean> {
    const target = this.pendingReturn;
    this.pendingReturn = null;
    if (!target) return Promise.resolve(false);
    return this.router.navigate([target.url], { queryParams: target.queryParams || {} });
  }

  clearReturn(): void { this.pendingReturn = null; }

  openInvoiceArchive(link: InvoiceArchiveLink, returnTo: ReturnTarget | null = null): Promise<boolean> {
    // A screen that offers no way back clears the last one, so a stale offer
    // never appears on a bill opened some other way.
    this.pendingReturn = returnTo;
    const p = PARAMS.invoiceArchive;
    return this.router.navigate(['/invoices'], {
      queryParams: withoutEmpty({
        [p.invoiceId]: link.invoiceId,
        [p.invoiceNumber]: link.invoiceNumber,
        [p.locCode]: link.locCode,
        [p.macCode]: link.macCode,
        [p.txnDate]: dateOnly(link.txnDate),
        [p.showReturned]: link.showReturned ? '1' : undefined
      })
    });
  }

  openBillingCopy(link: BillingCopyLink): Promise<boolean> {
    return this.router.navigate(['/billing'], {
      queryParams: { [PARAMS.billingCopy.copyFromInvoiceId]: link.copyFromInvoiceId }
    });
  }

  openReceiving(link: ReceivingLink): Promise<boolean> {
    return this.router.navigate(['/receiving'], {
      queryParams: withoutEmpty({ [PARAMS.receiving.open]: link.open, [PARAMS.receiving.lotId]: link.lotId })
    });
  }

  /**
   * Calls `apply` for each link that reaches this screen: the one it opened
   * with, and any that arrive while it stays open (a link to the same screen
   * reuses it rather than creating a new one). Unsubscribe in ngOnDestroy.
   */
  onLink<T>(route: ActivatedRoute, read: (params: ParamMap) => T | null, apply: (link: T) => void | Promise<void>): Subscription {
    return route.queryParamMap.subscribe((params) => {
      const link = read(params);
      if (link) void apply(link);
    });
  }

  /** Removes an applied link from the address without adding a history entry. */
  consume(route: ActivatedRoute): Promise<boolean> {
    const queryParams = Object.fromEntries(ALL_LINK_PARAMS.map((name) => [name, null]));
    return this.router.navigate([], { relativeTo: route, queryParams, queryParamsHandling: 'merge', replaceUrl: true });
  }
}

export function readInvoiceArchiveLink(params: ParamMap): InvoiceArchiveLink | null {
  const p = PARAMS.invoiceArchive;
  const invoiceId = positiveInteger(params.get(p.invoiceId));
  if (!invoiceId) return null;
  return {
    invoiceId,
    invoiceNumber: plainText(params.get(p.invoiceNumber)),
    locCode: plainText(params.get(p.locCode)),
    macCode: plainText(params.get(p.macCode)),
    txnDate: dateOnly(params.get(p.txnDate)),
    showReturned: params.get(p.showReturned) === '1'
  };
}

export function readBillingCopyLink(params: ParamMap): BillingCopyLink | null {
  const copyFromInvoiceId = positiveInteger(params.get(PARAMS.billingCopy.copyFromInvoiceId));
  return copyFromInvoiceId ? { copyFromInvoiceId } : null;
}

export function readReceivingLink(params: ParamMap): ReceivingLink | null {
  const open = params.get(PARAMS.receiving.open) as ReceivingLink['open'] | null;
  if (!open || !RECEIVING_TARGETS.includes(open)) return null;
  const lotId = positiveInteger(params.get(PARAMS.receiving.lotId));
  return lotId ? { open, lotId } : { open };
}

function positiveInteger(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function plainText(value: string | null): string | undefined {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 120) : undefined;
}

/**
 * A business date as YYYY-MM-DD. DATE columns cross IPC as Date objects, and
 * toISOString() would shift them a day early east of Greenwich, so the local
 * calendar parts are used.
 */
function dateOnly(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

function withoutEmpty(values: Record<string, unknown>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    result[key] = value as string | number;
  }
  return result;
}
