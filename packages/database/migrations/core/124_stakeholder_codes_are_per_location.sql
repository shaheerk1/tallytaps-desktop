-- Two people can share a name in different shops. A stakeholder's code is
-- derived from their name, so a business-wide unique code refused the second
-- "Khan" with a raw database error. A code only has to be unique where the
-- person belongs.
ALTER TABLE stakeholders
  DROP INDEX uq_stakeholders_code,
  ADD UNIQUE KEY uq_stakeholders_location_code (loc_code, stakeholder_code);
