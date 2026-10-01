# Adding a credit customer on the bill

Status: delivered 2026-10-01 (no migration)
Applies to: `desktop-app` (Billing → payment)

Leaving a bill pending needs a real customer account with credit enabled. The
only way to make one was to leave the bill, open Customer Accounts, add the
customer with the credit tick, and come back — which is a lot to do with a
customer standing at the counter.

The payment screen's customer search now carries the rest of the job:

- **Arrow keys** walk the matches and **Enter** takes the highlighted one;
  **Esc** closes the search when a customer is already linked.
- **Choosing a customer puts the cursor back in the amount**, which is what was
  being typed when the customer turned out to be missing.
- **+ New customer** opens a small panel on the same screen: name, shop,
  mobile, market code and an optional credit limit. **Credit is on from the
  start**, because the only reason to add a customer mid-bill is to leave the
  bill unpaid. It is saved through the same channel the Customer Accounts page
  uses, so nothing is a special case, and the new account is linked to the bill
  straight away.
- The button only appears for a user who may manage customers.

Everything else about credit is unchanged: a pending bill still needs credit
enabled, and a credit limit is still enforced at finalize.

## Verify

`npm run verify:credit-customer` — the customer comes back ready and is found
by the payment search, a bill can then be left pending against them, a customer
without credit is still refused, and a limit set while adding them still holds.
