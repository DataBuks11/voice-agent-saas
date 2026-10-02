-- 0007_availability: business hours / slot rules so the agent only offers real slots,
-- plus the booked-slot list used to avoid double booking.

alter table agents add column if not exists availability jsonb not null default '{}';
alter table agents add column if not exists booked_slots jsonb not null default '[]';