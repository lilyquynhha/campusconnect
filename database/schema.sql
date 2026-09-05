-- spaces: fixed campus layout
CREATE TABLE
    spaces (
        id text PRIMARY KEY,
        building text NOT NULL,
        level integer NOT NULL,
        room integer NOT NULL,
        quiet_zone boolean NOT NULL DEFAULT FALSE,
        capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 5),
        has_power_outlets boolean NOT NULL DEFAULT FALSE,
        has_tv boolean NOT NULL DEFAULT FALSE
    );

-- Indexes to support the booking search filters (quiet zone / capacity / amenities)
CREATE INDEX idx_spaces_quiet_zone ON spaces (quiet_zone);

CREATE INDEX idx_spaces_capacity ON spaces (capacity);

CREATE INDEX idx_spaces_amenities ON spaces (has_power_outlets, has_tv);