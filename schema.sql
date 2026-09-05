-- CampusConnect — Naive baseline schema
-- spaces: fixed campus hierarchy (not a scalability variable — see design notes)
-- space_status: naive-only table, written by Node-RED's debounce flow on every
--   5s reading (shares this RDS instance/connection pool with booking traffic
--   — this is the naive bottleneck being demonstrated, not an oversight)
CREATE TABLE spaces(
    id text PRIMARY KEY, -- e.g. 'A-1-01' — string PK, no composite key
    building text NOT NULL, -- e.g. 'A'
    level integer NOT NULL,
    room integer NOT NULL,
    quiet_zone boolean NOT NULL DEFAULT FALSE,
    capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 5),
    has_power_outlets boolean NOT NULL DEFAULT FALSE,
    has_tv boolean NOT NULL DEFAULT FALSE
);

-- Indexes to support the booking search filters (quiet zone / capacity / amenities)
CREATE INDEX idx_spaces_quiet_zone ON spaces(quiet_zone);

CREATE INDEX idx_spaces_capacity ON spaces(capacity);

CREATE INDEX idx_spaces_amenities ON spaces(has_power_outlets, has_tv);

CREATE TABLE space_status(
    space_id text PRIMARY KEY, -- deliberately NOT a FK to spaces(id):
    -- ADDITIONAL_SENSOR synthetic load-test
    -- IDs (e.g. 'LOAD-0001') write here too,
    -- and don't exist in the spaces table.
    current_status text NOT NULL DEFAULT 'unoccupied' CHECK (current_status IN ('occupied', 'unoccupied')),
    last_changed_at timestamptz,
    last_seen_at timestamptz
);

