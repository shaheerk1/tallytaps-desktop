# Business Monitor: Whose Figures, And What Counts As A Sale

Status: delivered 2026-09-12
Applies to: `desktop-app` (archive streams, invoice archive), `server-app`
(monitor read model), `mobile-app` (Business Monitor)

## Why This Exists

Two questions from the owner, both about reading the business honestly.

1. **Several shops and counters now report to one host.** The phone could only
   filter by *POS installation* — a technical thing that means nothing to an
   owner and does not match how the business is divided. Since location
   isolation shipped, `loc_code` is what separates a business: its own catalog,
   its own customers, its own books.
2. **Returned bills were being counted as sales.** On the phone a refunded bill
   sat in the list like any other and its money swelled the totals. On the
   desktop the invoice archive hid *any* bill with a refund against it, so a
   bill where one line of five came back disappeared entirely.

## Decisions

1. **The monitor is read by place, not by installation.** Every figure, list and
   total can be asked for the whole business, one shop, or one counter inside a
   shop. `locCode` and `macCode` are stamped on every archived record, so this
   is one filter applied consistently rather than a special report.
   The POS installation stays visible in the operations screen for support, but
   an owner is never asked to think in it.
2. **Shops lead, counters follow.** The picker offers "All shops together", then
   each shop, with its counters indented beneath it. Choosing a shop clears a
   counter that belonged to another shop; a shop that disappears from the host
   clears the selection rather than showing someone else's figures.
3. **A returned bill is a reversed sale, never a sale.** Every "sales",
   "collected" and best-seller figure is net:
   - the value of returned goods comes off the sale;
   - money actually handed back comes off what was collected;
   - returns count on the day and counter that made them, which is where the
     money left the drawer.
4. **Full and partial returns are treated differently in lists.** A bill
   returned in full is a reversal: hidden by default, kept and marked when
   asked for. A bill where part came back is still a sale that stood: always
   listed, marked, showing what it is now worth beside what it was.
5. **Value returned and money handed back are separate figures.** A credit sale
   can be returned without any cash leaving, so `refundedTotal` (goods) and
   `refundedCashTotal` (money) never share one column.

## What Changed

**desktop-app**
- `billing.repository.searchInvoices`: "hide returned" now hides only bills
  returned in full. Every row carries `refundedTotal`, `refundedCashTotal`,
  `netTotal`, `netCollected`.
- Invoice Archive: the filter reads "Show fully returned bills"; a returned row
  shows its original value struck through beside its net value; a summary line
  gives the listed bills, their net sales and what was returned.
- Cloud sync streams `pos_location` and `pos_workstation` (migration 110 adds
  `cloud_sync_updated_at` to `pos_workstations`), so the host learns the names
  of shops and counters instead of only their codes.
- Verifier: `npm run verify:refund-visibility`.

**server-app** (`src/services/monitor-service.js`)
- `scope()` filters by `locCode` and `macCode` as well as node; every monitor
  endpoint accepts them.
- `/monitor/terminals` returns `locations`, each with its named counters, built
  from the archived location registry.
- `/monitor/overview`: `collected` is net of money handed back;
  `refunds.cashReturned` added.
- `/monitor/sales`: every bucket carries `net`, `returned` and `refundCount`,
  with returns matched to the same bucket (for customer and status groups the
  return is read through the bill it came from).
- `/monitor/sales` items: returned quantities and value are taken off each item,
  so a returned line cannot hold a product at the top of the best-seller list.
- `/monitor/invoices`: each row carries `returnedTotal`, `returnedCashTotal`,
  `refundStatus`, `netTotal`, `netCollected`; the page carries `netTotal`,
  `netCollected` and `returnedTotal` for the whole filter. `returned=hide`
  (default) leaves out bills returned in full; `show` lists everything; `only`
  lists what has returns.
- `ARCHIVE_ENTITY_TYPES` accepts `pos_location` and `pos_workstation`.

**mobile-app**
- `MonitorScope` holds a place (`locCode`, `macCode`) instead of a node; the
  chip shows "All shops", a shop name, or "Shop · Counter".
- Bills: returned bills are marked, rows show net value, the header shows net
  sales and what was returned, and a "Returned bills" chip brings the fully
  returned ones back into view.
- Sales groups and the overview show net figures, with returns named underneath.
- Tests: `test/monitor_scope_test.dart`.

## Known Gaps

- The monitor still has no screen for the accounting spine — expenses, funds,
  partners, landed cost — although every one of those records now reaches the
  host. That is the next monitor feature, not a defect of this one.
- A desktop sales report drops a whole sale line when any part of its quantity
  was returned, rather than netting the returned part. The monitor nets by
  value, so the two can differ slightly on a part-quantity return.
