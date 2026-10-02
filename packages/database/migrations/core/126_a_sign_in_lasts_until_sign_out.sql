-- A counter is signed in for as long as the person is working it.
--
-- A sign-in used to die twelve hours after it was made, in the middle of
-- whatever was being typed, and a market day can easily run longer than that.
-- From here a session ends when someone ends it: signing out, switching
-- workstation, or the account being disabled.
--
-- The column stays, nullable: NULL means "no end", and any row still carrying
-- an end date (made before this change) is honoured and cleaned up as before.
-- It is declared without a default so that a server running with
-- explicit_defaults_for_timestamp off cannot quietly stamp it on every update.
ALTER TABLE sessions MODIFY COLUMN expires_at TIMESTAMP NULL DEFAULT NULL;

-- Whoever is signed in right now stays signed in.
UPDATE sessions SET expires_at = NULL WHERE expires_at > NOW();
