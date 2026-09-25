# A stakeholder's code belongs to their location

Status: delivered 2026-09-28 (migration 124)
Applies to: `desktop-app` (Money → Partners, and the pocket created with them)

A stakeholder's code is derived from their name, and the code had to be unique
across the whole business. Adding a second "Khan", in another shop or the same
one, failed with a raw database error:
`Duplicate entry 'KHAN' for key 'stakeholders.uq_stakeholders_code'`.

Names repeat, so:

- the unique key is now **(loc_code, stakeholder_code)**: the same name in
  another location is simply another person;
- a code already taken in that location gets `-2`, `-3` and so on, so two
  people of the same name in one shop are both accepted;
- the partner's pocket (`fund_accounts.fund_code`, still unique business-wide)
  is numbered the same way instead of failing.

Verify: `npm run verify:stakeholder-codes` — the same name in another shop, the
same name twice in one shop, and a pocket of their own for each.
