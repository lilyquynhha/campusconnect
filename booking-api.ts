/**
 * CampusConnect — Naive Booking API (TypeScript / ESM)
 *
 * Naive baseline scope, per the spec's design:
 *   - Single always-on Express process (no clustering, no Lambda) — run as
 *     a single node process, deliberately with no pm2/cluster wrapping.
 *   - Fixed, small pg.Pool (naive: shared with Node-RED's writes to the same
 *     Postgres instance — no RDS Proxy).
 *   - Booking conflict handling is explicit check-then-insert, NOT a DB
 *     constraint. This is a deliberate anti-pattern: under concurrent
 *     requests, two clients can both pass the SELECT checks before either
 *     INSERTs, producing genuine double-bookings. No SELECT ... FOR UPDATE
 *     either — see naive-solution-specs.md section 4.
 *   - Downstream side-effects on a successful booking (confirmation email,
 *     utilization_stats update, door-display MQTT) run inline, synchronously,
 *     before the HTTP response — no SNS fan-out.
 *
 * This pass covers: GET /spaces/search, POST /bookings.
 * NOT yet covered: cancellation, no-show/lifecycle resolution (Phase 6),
 * real auth (student_id is trusted directly from the request body for now).
 *
 * Setup:
 *   npm install express pg mqtt
 *   npm install -D @types/express @types/pg
 *   npx tsx booking-api.ts
 */

import express, { Request, Response } from "express";
import pgPkg from "pg";
import mqtt from "mqtt";
import "dotenv/config";

const { Pool } = pgPkg;

// ---- Config ----
const PORT = parseInt(process.env.PORT || "3000", 10);
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";

// Naive: fixed, small connection pool (10–20 range per spec), shared with
// Node-RED's writes to the same Postgres instance. No RDS Proxy.
const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE || "campusconnect",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  max: 15,
});

// Single shared MQTT connection for the door-display publish — created once
// at startup, not per-request.
const mqttClient = mqtt.connect(MQTT_BROKER_URL);
mqttClient.on("error", (err: Error) =>
  console.error("MQTT connection error:", err.message),
);

// ---- Business rules (identical to final version — see "What stays
// identical" in naive-solution-specs.md) ----
const MIN_DURATION_HOURS = 1;
const MAX_DURATION_HOURS = 5;
const MAX_ADVANCE_DAYS = 5;
const GRACE_PERIOD_MINUTES = 15;

// Phase 6: naive lifecycle resolution — polling, not event-driven.
// STALENESS_THRESHOLD_SECONDS matches the same 30s/6-missed-readings rule
// Node-RED's debounce logic uses, so a stale occupancy reading never
// incorrectly promotes a booking to 'active'.
const LIFECYCLE_POLL_INTERVAL_MS = parseInt(
  process.env.LIFECYCLE_POLL_INTERVAL_MS || "60000",
  10,
);
const STALENESS_THRESHOLD_SECONDS = 30;

interface CreateBookingBody {
  student_id?: string;
  space_id?: string;
  start_time?: string;
  end_time?: string;
}

interface Space {
  id: string;
  building: string;
  level: number;
  room: number;
  quiet_zone: boolean;
  capacity: number;
  has_power_outlets: boolean;
  has_tv: boolean;
}

// ---- Downstream side-effects (naive: inline, synchronous, no SNS) ----

// SES isn't available without AWS access — stubbed for now. Kept as an
// async function (even though it's just a log) so swapping in a real SES
// call later doesn't change the call site in the booking handler.
async function sendConfirmationEmailStub(
  studentId: string,
  space: Space,
  startTime: string,
): Promise<void> {
  console.log(
    `[stub email] Confirmation sent to ${studentId} for space ${space.id} at ${startTime}`,
  );
}

// Real DB write — increments the per building/level/day rollup used for
// historical trend analysis (separate concern from live occupancy).
async function updateUtilizationStats(
  space: Space,
  startTime: Date,
  durationHours: number,
): Promise<void> {
  const day = startTime.toISOString().slice(0, 10); // UTC date
  await pool.query(
    `INSERT INTO utilization_stats (building, level, day, total_bookings, total_booked_hours)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (building, level, day) DO UPDATE SET
       total_bookings = utilization_stats.total_bookings + 1,
       total_booked_hours = utilization_stats.total_booked_hours + $4`,
    [space.building, space.level, day, durationHours],
  );
}

// Real MQTT publish — door display reflects the new booking immediately.
function publishDoorDisplay(spaceId: string, message: string): void {
  mqttClient.publish(`display/${spaceId}`, message);
}

// ---- App ----
const app = express();
app.use(express.json());

/**
 * GET /spaces/search?start_time=...&end_time=...&quiet_zone=&capacity=&has_power_outlets=&has_tv=
 * Postgres-only query (bookings JOIN spaces), matching the final version's
 * search behaviour exactly — this part isn't part of the naive/final split.
 */
app.get("/spaces/search", async (req: Request, res: Response) => {
  const {
    start_time,
    end_time,
    quiet_zone,
    capacity,
    has_power_outlets,
    has_tv,
  } = req.query;

  if (!start_time || !end_time) {
    return res
      .status(400)
      .json({ error: "start_time and end_time are required query params" });
  }

  const quietZoneFilter =
    quiet_zone !== undefined ? quiet_zone === "true" : null;
  const capacityFilter =
    capacity !== undefined ? parseInt(capacity as string, 10) : null;
  const powerFilter =
    has_power_outlets !== undefined ? has_power_outlets === "true" : null;
  const tvFilter = has_tv !== undefined ? has_tv === "true" : null;

  try {
    const result = await pool.query(
      `SELECT s.*
       FROM spaces s
       WHERE ($1::boolean IS NULL OR s.quiet_zone = $1)
         AND ($2::int IS NULL OR s.capacity >= $2)
         AND ($3::boolean IS NULL OR s.has_power_outlets = $3)
         AND ($4::boolean IS NULL OR s.has_tv = $4)
         AND NOT EXISTS (
           SELECT 1 FROM bookings b
           WHERE b.space_id = s.id
             AND b.status IN ('confirmed', 'active')
             AND b.start_time < $6
             AND b.end_time > $5
         )
       ORDER BY s.id`,
      [
        quietZoneFilter,
        capacityFilter,
        powerFilter,
        tvFilter,
        start_time,
        end_time,
      ],
    );

    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Search failed:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

/**
 * POST /bookings
 * Body: { student_id, space_id, start_time, end_time }
 *
 * NAIVE CHECK-THEN-INSERT — deliberately race-prone. Two concurrent requests
 * can both pass both SELECT checks below before either INSERT commits,
 * producing a genuine double-booking or a student with two active bookings.
 * This is the correctness bug the load-test plan is designed to surface.
 */
app.post("/bookings", async (req: Request, res: Response) => {
  const { student_id, space_id, start_time, end_time } =
    req.body as CreateBookingBody;

  if (!student_id || !space_id || !start_time || !end_time) {
    return res.status(400).json({
      error: "student_id, space_id, start_time, and end_time are required",
    });
  }

  const startDate = new Date(start_time);
  const endDate = new Date(end_time);

  if (
    isNaN(startDate.getTime()) ||
    isNaN(endDate.getTime()) ||
    endDate <= startDate
  ) {
    return res.status(400).json({ error: "Invalid start_time/end_time" });
  }

  const durationHours =
    (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60);
  if (
    durationHours < MIN_DURATION_HOURS ||
    durationHours > MAX_DURATION_HOURS
  ) {
    return res.status(400).json({
      error: `Booking duration must be between ${MIN_DURATION_HOURS} and ${MAX_DURATION_HOURS} hours`,
    });
  }

  const now = new Date();
  const maxAdvance = new Date(
    now.getTime() + MAX_ADVANCE_DAYS * 24 * 60 * 60 * 1000,
  );
  if (startDate < now || startDate > maxAdvance) {
    return res.status(400).json({
      error: `start_time must be within the next ${MAX_ADVANCE_DAYS} days`,
    });
  }

  try {
    const spaceResult = await pool.query<Space>(
      "SELECT * FROM spaces WHERE id = $1",
      [space_id],
    );
    const space = spaceResult.rows[0];
    if (!space) {
      return res.status(404).json({ error: "Space not found" });
    }

    // --- Step 1: check for an overlapping booking on this space ---
    const overlapCheck = await pool.query(
      `SELECT 1 FROM bookings
       WHERE space_id = $1
         AND status IN ('confirmed', 'active')
         AND start_time < $3
         AND end_time > $2
       LIMIT 1`,
      [space_id, start_time, end_time],
    );
    if (overlapCheck.rowCount && overlapCheck.rowCount > 0) {
      return res
        .status(409)
        .json({ error: "This space was just booked by someone else" });
    }

    // --- Step 2: check the student doesn't already hold an active booking ---
    const activeCheck = await pool.query(
      `SELECT 1 FROM bookings
       WHERE student_id = $1
         AND status IN ('confirmed', 'active')
       LIMIT 1`,
      [student_id],
    );
    if (activeCheck.rowCount && activeCheck.rowCount > 0) {
      return res
        .status(409)
        .json({ error: "You already have an active booking" });
    }

    // --- Step 3: insert. Deliberately no transaction wrapping steps 1–3,
    // no SELECT ... FOR UPDATE — this gap is the race condition itself. ---
    const insertResult = await pool.query(
      `INSERT INTO bookings (student_id, space_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING *`,
      [student_id, space_id, start_time, end_time],
    );
    const booking = insertResult.rows[0];

    // --- Downstream side-effects: inline, synchronous, in this order ---
    await sendConfirmationEmailStub(student_id, space, start_time);
    await updateUtilizationStats(space, startDate, durationHours);
    publishDoorDisplay(space_id, `${space_id} booked.`);

    res.status(200).json({ booking, space });
  } catch (err) {
    console.error("Booking creation failed:", err);
    res.status(500).json({ error: "Booking creation failed" });
  }
});

app.listen(PORT, () => {
  console.log(
    `Naive Booking API listening on port ${PORT} (single instance, no clustering)`,
  );
});

// ---- Phase 6: lifecycle resolution (naive: polling loop, not
// DynamoDB Streams + EventBridge Scheduler) ----
// Runs inside this same always-on process, on the same connection pool and
// instance as booking traffic and Node-RED's writes — this is the "full-table
// scan pattern competing for shared resources" bottleneck the naive baseline
// is built to demonstrate. Deliberately no index on bookings.status or
// space_status.current_status, so these queries really do scan.
async function runLifecycleResolution(): Promise<void> {
  try {
    // Step 1: promote confirmed -> active for spaces currently occupied
    // (per Node-RED's debounced space_status), only trusting that signal
    // if it's fresh, and only within the booking's own time window.
    const promoted = await pool.query(
      `UPDATE bookings b
       SET status = 'active'
       FROM space_status ss
       WHERE b.space_id = ss.space_id
         AND b.status = 'confirmed'
         AND ss.current_status = 'occupied'
         AND ss.last_seen_at > NOW() - INTERVAL '${STALENESS_THRESHOLD_SECONDS} seconds'
         AND NOW() BETWEEN b.start_time AND b.end_time
       RETURNING b.id, b.space_id`,
    );

    // Step 2: release no-shows — confirmed bookings past the grace period
    // that never got promoted to active above. Joins spaces for
    // building/level so the no-show can be logged to utilization_stats.
    const released = await pool.query(
      `UPDATE bookings b
       SET status = 'released'
       FROM spaces s
       WHERE b.space_id = s.id
         AND b.status = 'confirmed'
         AND NOW() > b.start_time + INTERVAL '${GRACE_PERIOD_MINUTES} minutes'
       RETURNING b.id, b.space_id, b.start_time, s.building, s.level`,
    );

    for (const row of released.rows) {
      const day = new Date(row.start_time).toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO utilization_stats (building, level, day, total_no_shows)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (building, level, day) DO UPDATE SET
           total_no_shows = utilization_stats.total_no_shows + 1`,
        [row.building, row.level, day],
      );
      publishDoorDisplay(row.space_id, "Available");
    }

    // Step 3: end active bookings whose window has passed.
    const ended = await pool.query(
      `UPDATE bookings
       SET status = 'ended'
       WHERE status = 'active'
         AND NOW() > end_time
       RETURNING id, space_id`,
    );

    for (const row of ended.rows) {
      publishDoorDisplay(row.space_id, `${row.space_id} available`);
    }

    if (promoted.rowCount || released.rowCount || ended.rowCount) {
      console.log(
        `[lifecycle] promoted(active)=${promoted.rowCount} released(no-show)=${released.rowCount} ended=${ended.rowCount}`,
      );
    }
  } catch (err) {
    console.error("Lifecycle resolution poll failed:", err);
  }
}

// Run once at startup (fast feedback while testing) then on the interval.
runLifecycleResolution();
setInterval(runLifecycleResolution, LIFECYCLE_POLL_INTERVAL_MS);
