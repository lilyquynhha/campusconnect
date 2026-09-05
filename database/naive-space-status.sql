-- space_status: naive-only table, written by Node-RED's debounce flow on every 5s reading
CREATE TABLE
    space_status (
        space_id text PRIMARY KEY, -- deliberately NOT a FK to spaces(id) because synthetic readings are written here too
        current_status text NOT NULL DEFAULT 'unoccupied' CHECK (current_status IN ('occupied', 'unoccupied')),
        last_changed_at timestamptz,
        last_seen_at timestamptz
    );