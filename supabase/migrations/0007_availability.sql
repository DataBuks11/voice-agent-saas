-- 0007_availability: business hours / slot rules so the agent only offers real slots,
-- plus the booked-slot list used to avoid double booking.

alter table agents add column if not exists availability jsonb not null default '{}';
alter table agents add column if not exists booked_slots jsonb not null default '[]';
-- Verify (run after the two alters above):
--   select column_name, data_type, column_default
--   from information_schema.columns
--   where table_name = 'agents' and column_name in ('availability', 'booked_slots');
-- Optional: give one agent real hours, then confirm the agent respects them.
--   update agents set availability = '{"open":"09:00","close":"18:00","slotMinutes":30,"bufferMinutes":10,"closedDates":[],"booked":[]}'::jsonb
--   where id = (select id from agents limit 1);
