-- 0006_capture_pending: persist the value awaiting confirmation so a read-back
-- survives the round trip through the database (each turn reloads the session).

alter table capture_sessions add column if not exists pending_key text;
alter table capture_sessions add column if not exists pending_value text;
alter table capture_sessions add column if not exists pending_iso text;
