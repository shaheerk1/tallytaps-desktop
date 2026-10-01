# Writing up a delivery

Status: delivered 2026-10-01 (no migration)
Applies to: `desktop-app` (Supplier Receiving → GRN)

The old line was a row of bare boxes under one set of headings, so every field
had to be guessed at from its position, and the item had to be found by
scrolling a long native dropdown.

## The line now

Each item is its own bordered row, numbered, with every field **labelled above
it** and its unit written inside the box: *Unit count* `BAG`, *Measured* `KILO`,
*Cost* `per KILO`. The row ends with the **line value**, and the list ends with
the number of items and the goods value, so the delivery adds up in view.

- **The item is typed, not scrolled.** The field is a search box: type part of a
  name or code, pick with the arrow keys, take it with Enter. Each suggestion
  says which measures that item is kept in. The field is never a wall of
  hundreds of options.
- **The second measure only appears when the item has one.** Otherwise the box
  says *not kept*, greyed, rather than looking like something forgotten.
- **How the measure is taken** reads as *Weighed as it came* or *Same every
  unit*, with the expected ratio and its warning percent beside it, and under
  them the actual ratio in plain words: "Came in at 23.5 KILO per BAG · 4% off
  the expected".
- **Enter walks the line** and, at the end of one, adds the next — the same
  keyboard flow as Cash Management, since the same hands use both.

## Reading one back

The finished note is a proper table: item with its code, unit count, measured
amount, cost, line value, and how it was measured, with a totals row. Measures
print as a person writes them — **100 BAG, not 100.000 BAG** — and the GRN list
says "4 lines · 100 received" the same way.

## Narrow screens

The line folds rather than spilling. Below a wide screen it becomes three
bands — the item across the top, then count, measured, cost and value, then how
it is measured — and on a small screen four. Every field has a named place at
each width, so nothing escapes the card and the remove button never lands on
top of anything.

A note for later: the editor rows are `.grn-item-row`. The GRN **list** owns
`.grn-row`, and the two collided while the editor briefly shared that name,
which is what pushed Cost outside the form.

## Verify

Covered by the existing GRN checks: `npm run verify:grn-supplier`,
`npm run verify:grn-removal`, `npm run verify:lot-expense-flow`.
