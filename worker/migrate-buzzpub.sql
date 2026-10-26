-- Buzzpoints packets as static files (worker.js "buzzpoints packets as
-- static files"): the tournament's buzzpoints key, encrypted under its
-- content key, and the finished rounds already published under it.
ALTER TABLE tournaments ADD COLUMN buzz_key_enc TEXT;
ALTER TABLE tournaments ADD COLUMN buzz_pub TEXT;
