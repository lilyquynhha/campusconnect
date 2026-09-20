/**
 * CampusConnect — Booking API, Lambda version (TypeScript / ESM)
 *
 * Replaces booking-api.ts (naive, EC2, always-on Express). Same route
 * logic, three real changes:
 *
 *   1. Conflict handling: no more check-then-insert. INSERT is attempted
 *      directly; the two DB-level constraints from migration_001 reject
 *      bad writes atomically, and this handler just catches the specific
 *      Postgres error and maps it to the same 409 messages as before.
 *   2. Downstream side-effects: the naive version's inline SES stub,
 *      inline utilization_stats update, and inline MQTT publish are gone.
 *      A single SNS publish (`booking-confirmed`) replaces all three —
 *      the Lambdas that actually act on that event are step 4, not here.
 *   3. Deployment target: wrapped with serverless-http and exported as
 *      `handler`, for API Gateway -> Lambda instead of `app.listen()`.
 *
 * Deliberately NOT carried over from booking-api.ts: the lifecycle
 * polling loop (setInterval-based). It can't be — a Lambda invocation
 * ends when it returns a response, so nothing scheduled inside it would
 * ever fire. That logic is rebuilt as its own EventBridge-triggered
 * Lambda in step 5, not adapted from this file.
 *
 * Still deferred, same as the naive version: cancellation endpoint
 * (step 6), real auth — student_id is still trusted from the request
 * body (step 7).
 *
 * Setup:
 *   npm install express pg serverless-http @aws-sdk/client-sns
 *   npm install -D @types/express @types/pg
 */

import express, { Request, Response } from "express";
import serverlessHttp from "serverless-http";
import pgPkg from "pg";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import "dotenv/config";

const { Pool } = pgPkg;

// ---- Config ----
// Same fixed-pool shape as the naive version, but this pool is no longer
// shared with Node-RED's writes (those go to DynamoDB now) — it only ever
// serves booking traffic, which is the point of the split.
const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE || "campusconnect",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  max: 15,
  ssl: { rejectUnauthorized: false },
});

const sns = new SNSClient({});
const BOOKING_CONFIRMED_TOPIC_ARN = process.env.BOOKING_CONFIRMED_TOPIC_ARN!;

// ---- Business rules (unchanged) ----
const MIN_DURATION_HOURS = 1;
const MAX_DURATION_HOURS = 5;
const MAX_ADVANCE_DAYS = 5;

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

// ---- App ----
const app = express();
app.use(express.json());

/**
 * GET /spaces/search?start_time=...&end_time=...&quiet_zone=&capacity=&has_power_outlets=&has_tv=
 * Unchanged from the naive version — this query was never part of the
 * naive/final split.
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
 * No more explicit overlap/active-booking SELECTs. The INSERT is attempted
 * directly; migration_001's EXCLUDE constraint and unique partial index
 * reject a bad write atomically, so there's no window for two concurrent
 * requests to both pass a check before either commits — the race the
 * naive version's load test demonstrated is closed at the database level.
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

    let booking;
    try {
      const insertResult = await pool.query(
        `INSERT INTO bookings (student_id, space_id, start_time, end_time, status)
         VALUES ($1, $2, $3, $4, 'confirmed')
         RETURNING *`,
        [student_id, space_id, start_time, end_time],
      );
      booking = insertResult.rows[0];
    } catch (err: any) {
      // 23505 = unique_violation, 23P01 = exclusion_violation. Distinguish
      // by constraint name (set explicitly in migration_001) rather than
      // code alone, since both map to the same SQLSTATE class here.
      if (
        err.code === "23505" &&
        err.constraint === "bookings_one_active_per_student"
      ) {
        return res
          .status(409)
          .json({ error: "You already have an active booking" });
      }
      if (
        err.code === "23P01" &&
        err.constraint === "bookings_no_space_overlap"
      ) {
        return res
          .status(409)
          .json({ error: "This space was just booked by someone else" });
      }
      throw err;
    }

    // Success path: publish once, respond once. No SES call, no
    // utilization_stats write, no MQTT publish here anymore — those are
    // the step-4 subscribers' jobs, not this handler's.
    await sns.send(
      new PublishCommand({
        TopicArn: BOOKING_CONFIRMED_TOPIC_ARN,
        Message: JSON.stringify({ booking, space }),
        MessageAttributes: {
          event_type: { DataType: "String", StringValue: "booking-confirmed" },
        },
      }),
    );

    res.status(200).json({ booking, space });
  } catch (err) {
    console.error("Booking creation failed:", err);
    res.status(500).json({ error: "Booking creation failed" });
  }
});

export const handler = serverlessHttp(app);

// Local-only convenience: lets you run `tsx booking-lambda.ts` and hit
// http://localhost:3000 directly during development. API Gateway invokes
// `handler` above in the deployed system and never executes this block.
if (process.env.LOCAL_DEV === "true") {
  app.listen(3000, () => console.log("Local dev server on :3000"));
}
