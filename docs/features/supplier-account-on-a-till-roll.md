# A supplier account, on a till roll

Status: delivered 2026-10-02 (no database change)
Applies to: `desktop-app` (Supplier Accounts → a supplier's sheet)

A supplier standing at the counter wants their account on paper, now, not a PDF
emailed later. The sheet already saved to PDF and Excel; it now prints to the
80mm receipt printer as well, with **Thermal print** beside those two.

## It prints what is on the screen

The document is built from the sheet already loaded, not from a fresh query, so
what prints is what the shop is looking at:

- **Compact** prints one line per statement at its net payable; **Detailed**
  prints the subtotal, commission, credits and deductions behind each one.
- A **From / To** range prints only that period, keeps the balance brought
  forward at the top, and says the period in the header.
- The header records how it was shown (`Detailed` or `Compact`) and over what
  period, so two different printouts of the same account can never be confused.

## The layout

Forty-eight characters, which is an 80mm roll at the printer's normal font.

```
                SUPPLIER ACCOUNT
------------------------------------------------
Supplier      Nimal Traders (Dambulla)
Code          SUP-012
Period        28 Sep 2026 to 02 Oct 2026
Shown as      Detailed
------------------------------------------------
Balance brought forward                44,500.00
------------------------------------------------
28 Sep 2026  STATEMENT SPS-000118
  Goods subtotal                      +73,800.00
    480 kg tomato, 90 kg leeks
  Commission 10%                       -7,380.00
  Transport deduction                  -2,500.00
    Lorry hire EXP-000221
                           Balance    108,420.00
29 Sep 2026  PAYMENT SPY-000471
  Payment from Cash safe              -60,000.00
                           Balance     48,420.00
------------------------------------------------
Owed to supplier (+)                  114,800.00
Paid and deducted (-)                  95,180.00
================================================
BALANCE DUE                            64,120.00
We owe the supplier
```

Decisions worth keeping:

- **One running balance per entry**, printed after the parts it is made of, so
  a supplier can follow the account down the page the way they would a passbook.
  Every figure sits in the same column, including the balance.
- **A reversed entry says so on a line of its own.** Appended to the
  description it was the first thing truncation threw away, which is the one
  thing on an account that must never be lost.
- **A credit balance is marked `CR`** rather than printed with a minus, which
  is how a supplier reads a balance in their favour.
- **The closing balance is the headline**, because a statement for a past
  period must not be read as today's position. When a date range is set and
  today's balance differs, `Balance today` is printed under it.
- The footer asks the supplier to check it and say if anything differs.

## One change outside this screen

`escpos-printer.service.js` ruled a line both after `preLines` and before
`totals`, which printed two identical rules in a row for any document with no
items. The first rule is now drawn only when there are items; a document with
items is unchanged.

Checked by rendering both views at 48 columns before shipping, and by
`npm run verify:receipt-layout`.

---

# And the customer's side

Status: delivered 2026-10-02 (no database change)
Applies to: `desktop-app` (Customer Accounts → Print statement)

The customer statement printed every receivable entry ever recorded against the
account — raw entry types, payments and refunds mixed together — which answers
nothing a customer asks at the counter and reads like an accusation.

It now answers the one question: **which bills are still open, and what do they
come to?**

```
              STATEMENT OF ACCOUNT
------------------------------------------------
Customer      Nimal Stores (Kurunegala)
Account       CUS-000142
Codes         A12, B7
Mobile        071 884 1200
Printed       02/10/2026, 14:41
------------------------------------------------
These bills are still to be settled:
------------------------------------------------
05/09/2026  INV-000881  due 12/09/2026
  Bill total                           12,500.00
  Paid so far                          -5,000.00
                      Still to pay      7,500.00
12/09/2026  INV-000902
  Bill total                            9,800.00
                      Still to pay      9,800.00
------------------------------------------------
Bills still open                               2
Billed                                 22,300.00
Paid so far                            -5,000.00
================================================
TOTAL OUTSTANDING                  Rs. 27,300.00
Cheques with us, not cleared           10,000.00
Advance held for you                    5,000.00
```

- Only bills with something left on them are listed, oldest due first, each
  with what it came to, what has already gone against it, and what is left.
- It carries the shop's own branded masthead, the same one the customer's bills
  print with, through the receipt settings.
- **Cheques not yet cleared** and **an advance held** are printed under the
  total, separate from it. Neither is part of what is owed — they are there so
  the customer can see what of theirs the shop is holding.
- The **From / To** range narrows the bills, and the header then says which
  dates. When a range hides part of the account, both the total for the bills
  listed and the account's true outstanding are printed, so neither can be
  mistaken for the other.
- A settled account prints "No bills are open. Thank you."
- A due date is only shown when it differs from the bill date, because bills
  without payment terms carry their own date as the due date.

## Two printers, one document

A receipt in any language but `en-LK` is drawn as an image by
`receipt-raster.service.js` rather than printed as text, and that renderer drew
only `brand`, `meta`, `items`, `totals` and `footerLines`. **`preLines` were
silently dropped.** On a Sinhala till the first build of this statement printed
its header and its total with nothing in between.

Two things came out of that:

- The customer statement carries its bills in **`items`**, which both renderers
  lay out: the bill number and date as the line's title, what is left to pay as
  its amount, and the bill total, what has been paid and the due date beneath.
- The raster renderer now **renders `preLines`** too, in a monospaced block 48
  characters wide, so a document that lays itself out in columns keeps them.
  That is what lets the supplier sheet above keep its ledger layout while also
  carrying the shop's own masthead, logo and Sinhala name, as a bill does.

The only other document using `preLines` is the mobile bill in the Field
Transaction Inbox, whose note was being dropped on a Sinhala till and now
prints.

Checked by rendering the customer statement and the supplier sheet through the
real raster renderer, and both at 48 columns on the text path, before shipping.
