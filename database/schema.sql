-- CampusConnect — Naive baseline schema
-- spaces: fixed campus hierarchy (not a scalability variable — see design notes)
-- space_status: naive-only table, written by Node-RED's debounce flow on every
--   5s reading (shares this RDS instance/connection pool with booking traffic
--   — this is the naive bottleneck being demonstrated, not an oversight)
CREATE TABLE
    spaces (
        id TEXT PRIMARY KEY, -- e.g. 'A-1-01' — string PK, no composite key
        building TEXT NOT NULL, -- e.g. 'A'
        level INTEGER NOT NULL,
        room INTEGER NOT NULL,
        quiet_zone BOOLEAN NOT NULL DEFAULT FALSE,
        capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 5),
        has_power_outlets BOOLEAN NOT NULL DEFAULT FALSE,
        has_tv BOOLEAN NOT NULL DEFAULT FALSE
    );

-- Indexes to support the booking search filters (quiet zone / capacity / amenities)
CREATE INDEX idx_spaces_quiet_zone ON spaces (quiet_zone);

CREATE INDEX idx_spaces_capacity ON spaces (capacity);

CREATE INDEX idx_spaces_amenities ON spaces (has_power_outlets, has_tv);

CREATE TABLE
    space_status (
        space_id TEXT PRIMARY KEY, -- deliberately NOT a FK to spaces(id):
        -- ADDITIONAL_SENSOR synthetic load-test
        -- IDs (e.g. 'LOAD-0001') write here too,
        -- and don't exist in the spaces table.
        current_status TEXT NOT NULL DEFAULT 'unoccupied' CHECK (current_status IN ('occupied', 'unoccupied')),
        last_changed_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ
    );

-- users: minimal stand-in until Cognito/local-auth is wired up. Booking API
-- currently trusts student_id from the request body directly (no auth yet).
CREATE TABLE
    users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE
    );

CREATE TABLE
    bookings (
        id SERIAL PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES users (id),
        space_id TEXT NOT NULL REFERENCES spaces (id),
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed' CHECK (
            status IN (
                'confirmed',
                'active',
                'released',
                'ended',
                'cancelled'
            )
        )
    );

-- Deliberately NO EXCLUDE constraint (per-space overlap) and NO unique
-- partial index (one active booking per student) here. In the final version
-- these two rules are enforced atomically by Postgres itself. In the naive
-- version, the Booking API enforces both via explicit check-then-insert —
-- that's the race condition this baseline exists to demonstrate.
CREATE INDEX idx_bookings_space_time ON bookings (space_id, start_time, end_time);

CREATE INDEX idx_bookings_student_status ON bookings (student_id, status);

-- utilization_stats: rollup table, incremented inline by the naive Booking
-- API on every successful booking (final version does this async via SNS +
-- Analytics Lambda instead).
CREATE TABLE
    utilization_stats (
        building TEXT NOT NULL,
        level INTEGER NOT NULL,
        day DATE NOT NULL,
        total_bookings INTEGER NOT NULL DEFAULT 0,
        total_no_shows INTEGER NOT NULL DEFAULT 0,
        total_cancellations INTEGER NOT NULL DEFAULT 0,
        total_booked_hours NUMERIC NOT NULL DEFAULT 0,
        PRIMARY KEY (building, level, day)
    );