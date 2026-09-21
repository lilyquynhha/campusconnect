/**
 * CampusConnect — Analytics Lambda
 *
 * Subscribed to: booking-confirmed, booking-not-honoured, booking-cancelled.
 *
 * This is the one SNS subscriber that does real work rather than stubbing
 * an external call — it just writes to the same RDS instance BookingAPI
 * already reaches, so no new network setup is needed (same VPC/subnets/
 * security group). It replaces the naive version's inline
 * `updateUtilizationStats()` call and the no-show branch of its polling
 * loop's `released` handling — both now happen here, async, off the
 * request/response path.
 *
 * One function, one topic subscription mechanism, three event types —
 * distinguished by the `event_type` message attribute set by each
 * publisher, not by parsing the message body.
 */

import { SNSEvent } from "aws-lambda";
import pgPkg from "pg";

const { Pool } = pgPkg;

const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 5, // small — this Lambda only ever does one write per invocation
  ssl: { rejectUnauthorized: false },
});

interface BookingConfirmedPayload {
  booking: { start_time: string; end_time: string };
  space: { building: string; level: number };
}

interface NoShowOrCancelPayload {
  booking: { start_time: string };
  space: { building: string; level: number };
}

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    const eventType = record.Sns.MessageAttributes?.event_type?.Value;

    try {
      switch (eventType) {
        case "booking-confirmed": {
          const { booking, space } = JSON.parse(
            record.Sns.Message,
          ) as BookingConfirmedPayload;
          const day = booking.start_time.slice(0, 10);
          const durationHours =
            (new Date(booking.end_time).getTime() -
              new Date(booking.start_time).getTime()) /
            (1000 * 60 * 60);

          await pool.query(
            `INSERT INTO utilization_stats (building, level, day, total_bookings, total_booked_hours)
             VALUES ($1, $2, $3, 1, $4)
             ON CONFLICT (building, level, day) DO UPDATE SET
               total_bookings = utilization_stats.total_bookings + 1,
               total_booked_hours = utilization_stats.total_booked_hours + $4`,
            [space.building, space.level, day, durationHours],
          );
          break;
        }

        case "booking-not-honoured": {
          // No-show: published by the Housekeeping Lambda in step 5.
          const { booking, space } = JSON.parse(
            record.Sns.Message,
          ) as NoShowOrCancelPayload;
          const day = booking.start_time.slice(0, 10);

          await pool.query(
            `INSERT INTO utilization_stats (building, level, day, total_no_shows)
             VALUES ($1, $2, $3, 1)
             ON CONFLICT (building, level, day) DO UPDATE SET
               total_no_shows = utilization_stats.total_no_shows + 1`,
            [space.building, space.level, day],
          );
          break;
        }

        case "booking-cancelled": {
          // Published by the cancellation endpoint in step 6.
          const { booking, space } = JSON.parse(
            record.Sns.Message,
          ) as NoShowOrCancelPayload;
          const day = booking.start_time.slice(0, 10);

          await pool.query(
            `INSERT INTO utilization_stats (building, level, day, total_cancellations)
             VALUES ($1, $2, $3, 1)
             ON CONFLICT (building, level, day) DO UPDATE SET
               total_cancellations = utilization_stats.total_cancellations + 1`,
            [space.building, space.level, day],
          );
          break;
        }

        default:
          console.warn(`Analytics Lambda: unhandled event_type "${eventType}"`);
      }
    } catch (err) {
      // Log and continue to the next record rather than throwing — one
      // malformed/unexpected event shouldn't block the rest of the batch,
      // and SNS doesn't expect a response body from this handler.
      console.error("Analytics Lambda: failed to process record", err);
    }
  }
};
