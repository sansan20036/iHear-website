-- Room channel (2026-11-23) DRAFT: takes the four tables of 031_classroom_room_channel.sql away
-- again. Everything in them is short-lived by design (a whiteboard at most 48 hours, a chat at most
-- 6), so nothing here needs a backup first. Not a migration; see the note in the up file.
DROP TABLE IF EXISTS public.classroom_room_board_ops;
DROP TABLE IF EXISTS public.classroom_room_board_parts;
DROP TABLE IF EXISTS public.classroom_room_board_lines;
DROP TABLE IF EXISTS public.classroom_room_channel;
