/**
 * How money reads on a printed bill.
 *
 * A thermal bill is read at arm's length across a counter, often in a hurry,
 * so a long figure has to break into thousands the way it does on screen:
 * 1,234,567.00 rather than 1234567.00. The screen already groups amounts
 * through Angular's number pipe; this is the same grouping for everything that
 * goes to a printer.
 *
 * The locale is pinned rather than taken from the machine: a bill must print
 * the same digits on every terminal, and a locale that groups differently (or
 * swaps comma and dot) would change what the customer is handed.
 */
const GROUPED = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

/** 1234567.5 -> "1,234,567.50". Not a number -> "0.00". */
export function groupedAmount(value: unknown): string {
  const amount = Number(value);
  return GROUPED.format(Number.isFinite(amount) ? amount : 0);
}

/** The same figure with the store's currency symbol in front. */
export function receiptMoney(value: unknown, currencySymbol?: string | null): string {
  const symbol = String(currencySymbol ?? '').trim();
  const amount = groupedAmount(value);
  return symbol ? `${symbol} ${amount}` : amount;
}
