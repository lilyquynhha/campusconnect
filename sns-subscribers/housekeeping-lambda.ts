/**
 * CampusConnect — Housekeeping Lambda
 *
 * Trigger: EventBridge rate rule, every ~1 minute.
 *
 * Per spec Section 7b: reacts to elapsed time, not a signal — the
 * complement to the No-Show Resolver's positive-event trigger.
 *
 * The only Lambda in step 5 that both talks to RDS (VPC-attached, same as
 * BookingAPI/Analytics) AND makes its own DynamoDB API call (staleness
 * check) — hence the one that actually needs the DynamoDB Gateway VPC
 * Endpoint set up alongside this.
 */

import pgPkg from "pg";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const { Pool } = pgPkg;

const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 5,
  ssl: { rejectUnauthorized: false },
});

const sns = new SNSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BOOKING_NOT_HONOURED_TOPIC_ARN =
  process.env.BOOKING_NOT_HONOURED_TOPIC_ARN!;
const GRACE_PERIOD_MINUTES = 15;
const STALENESS_THRESHOLD_SECONDS = 30;
const BOOKING_ENDED_TOPIC_ARN = process.env.BOOKING_ENDED_TOPIC_ARN!;

// Per spec Section 2b/7b: a space whose sensor hasn't reported recently
// must NOT count against the student — a dead sensor looking unoccupied
// isn't evidence of a no-show. Treat "never reported at all" as stale too,
// for the same reason (fail toward not releasing, not toward false-releasing).
async function isStale(spaceId: string): Promise<boolean> {
  const result = await ddb.send(
    new GetCommand({ TableName: "SpaceState", Key: { space_id: spaceId } }),
  );
  const item = result.Item;
  if (!item?.last_seen_at) return true;
  const ageSeconds =
    (Date.now() - new Date(item.last_seen_at).getTime()) / 1000;
  return ageSeconds > STALENESS_THRESHOLD_SECONDS;
}

export const handler = async (): Promise<void> => {
  // --- Step 1: release no-shows ---
  const candidates = await pool.query(
    `SELECT * FROM bookings
     WHERE status = 'confirmed'
       AND NOW() > start_time + INTERVAL '${GRACE_PERIOD_MINUTES} minutes'`,
  );

  for (const booking of candidates.rows) {
    try {
      if (await isStale(booking.space_id)) {
        console.log(
          `Skipping release for ${booking.space_id}: sensor stale, avoiding a false no-show`,
        );
        continue;
      }

      const released = await pool.query(
        `UPDATE bookings SET status = 'released'
         WHERE id = $1 AND status = 'confirmed'
         RETURNING *`,
        [booking.id],
      );
      if (released.rowCount === 0) continue; // already handled (e.g. a concurrent run, or promoted just in time)

      const spaceResult = await pool.query(
        "SELECT * FROM spaces WHERE id = $1",
        [booking.space_id],
      );

      await sns.send(
        new PublishCommand({
          TopicArn: BOOKING_NOT_HONOURED_TOPIC_ARN,
          Message: JSON.stringify({
            booking: released.rows[0],
            space: spaceResult.rows[0],
          }),
          MessageAttributes: {
            event_type: {
              DataType: "String",
              StringValue: "booking-not-honoured",
            },
          },
        }),
      );
    } catch (err) {
      console.error(
        `Housekeeping Lambda: failed to release booking ${booking.id}`,
        err,
      );
    }
  }

  // --- Step 2: end active bookings whose window has passed ---
  // No SNS publish here, matching spec Section 7b exactly as written —
  // see the note in chat about this being a likely gap for Door-Display.
  try {
    const endedBookings = await pool.query(
      `UPDATE bookings SET status = 'ended'
     WHERE status = 'active' AND NOW() > end_time
     RETURNING *`,
    );

    for (const booking of endedBookings.rows) {
      const spaceResult = await pool.query(
        "SELECT * FROM spaces WHERE id = $1",
        [booking.space_id],
      );
      const space = spaceResult.rows[0];

      await sns.send(
        new PublishCommand({
          TopicArn: BOOKING_ENDED_TOPIC_ARN,
          Message: JSON.stringify({ booking, space }),
          MessageAttributes: {
            event_type: {
              DataType: "String",
              StringValue: "booking-ended",
            },
          },
        }),
      );
    }
  } catch (err) {
    console.error(
      "Housekeeping Lambda: failed to end expired active bookings",
      err,
    );
  }
};
