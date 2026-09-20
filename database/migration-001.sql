-- Migration 001: replace naive check-then-insert with DB-level concurrency
-- control, per final-specs-v2.md Section 4.
--
-- Fixes the race condition confirmed by the naive load test: two concurrent
-- POST /bookings requests could both pass the SELECT checks in
-- booking-api.ts before either INSERT committed, producing either
--   (a) two overlapping bookings on the same space, or
--   (b) one student holding two active/confirmed bookings at once.
--
-- After this migration, both rules are enforced atomically by Postgres
-- itself. The application no longer needs (and should stop performing)
-- the "Step 1" / "Step 2" SELECT checks in the booking handler — it should
-- just attempt the INSERT and catch the resulting constraint-violation
-- error. That handler change is a separate piece of work (the Lambda
-- refactor); this migration only touches the database.
--
-- Run against the existing naive RDS instance:
--   psql -h <rds-endpoint> -U postgres -d campusconnect -f migration_001_booking_constraints.sql

BEGIN;

-- 1. Required for the EXCLUDE constraint below: GiST needs this extension
--    to index the equality comparison on space_id (a plain TEXT column)
--    alongside the range-overlap comparison on the time window. Without it,
--    GiST only knows how to do range/geometric operators, not `=`.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2. Per-space overlap: no two bookings for the same space, in a status
--    that actually holds the space, may have overlapping time ranges.
--
--    - space_id WITH =        -> only compare rows for the same space
--    - tstzrange(...) WITH && -> ... and reject them if their time ranges overlap
--    - WHERE clause            -> only "live" bookings compete for the space;
--                                 a cancelled/released/ended row doesn't block
--                                 a new booking from reusing that space_id/time.
--
--    tstzrange's default bounds are [start, end) -- inclusive start,
--    exclusive end -- so a booking ending at 3pm and one starting at 3pm
--    do NOT count as overlapping. That matches the naive version's
--    overlap check (`start_time < $3 AND end_time > $2`), so behaviour is
--    unchanged, just atomic now.
ALTER TABLE bookings
    ADD CONSTRAINT bookings_no_space_overlap
    EXCLUDE USING gist (
        space_id WITH =,
        tstzrange(start_time, end_time) WITH &&
    )
    WHERE (status IN ('confirmed', 'active'));

-- 3. One active-or-confirmed booking per student, regardless of space or
--    time. A plain UNIQUE index can't express "unique only for these
--    status values" -- that's what the partial WHERE clause is for.
--    (A second EXCLUDE constraint was considered, per the spec, but this
--    is a simpler fit: "at most one row in this state," not a range check.)
CREATE UNIQUE INDEX bookings_one_active_per_student
    ON bookings (student_id)
    WHERE status IN ('confirmed', 'active');

COMMIT;

-- ---------------------------------------------------------------------
-- Verification queries (run manually, not part of the migration itself)
-- ---------------------------------------------------------------------
-- Confirm both objects exist:
--   \d bookings
--
-- Confirm existing naive data (if any) doesn't already violate these
-- rules -- if the migration above fails, it's because it does, and you'll
-- need to resolve those rows (e.g. the double-bookings your load test
-- produced) before the constraint can be added:
--
--   SELECT space_id, count(*) FROM bookings
--   WHERE status IN ('confirmed','active')
--   GROUP BY space_id, tstzrange(start_time, end_time)
--   HAVING count(*) > 1;
--
--   SELECT student_id, count(*) FROM bookings
--   WHERE status IN ('confirmed','active')
--   GROUP BY student_id
--   HAVING count(*) > 1;