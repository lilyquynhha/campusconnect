/**
 * CampusConnect — No-Show Resolver Lambda
 *
 * Trigger: DynamoDB Streams on the SpaceState table (event source mapping,
 * not a direct SNS/API subscription — Lambda's stream-polling service
 * invokes this directly with the changed record already attached).
 *
 * Per spec Section 7a: reacts to a *positive* signal (occupancy detected),
 * as opposed to the Housekeeping Lambda's time-based, absence-of-signal
 * logic below.
 */

import { DynamoDBStreamEvent } from "aws-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import pgPkg from "pg";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

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
const BOOKING_HONOURED_TOPIC_ARN = process.env.BOOKING_HONOURED_TOPIC_ARN!;

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      if (!record.dynamodb?.NewImage) continue;

      const newImage = unmarshall(record.dynamodb.NewImage as any);
      const oldImage = record.dynamodb.OldImage
        ? unmarshall(record.dynamodb.OldImage as any)
        : null;

      // Node-RED writes every 5s regardless of status change (last_seen_at
      // always moves), but last_changed_at only moves on a genuine
      // debounced flip. Skip the heartbeat writes — cuts needless RDS
      // queries; correctness doesn't depend on this filter, since the
      // UPDATE below is itself idempotent (WHERE status = 'confirmed').
      const isGenuineFlip =
        !oldImage || oldImage.last_changed_at !== newImage.last_changed_at;
      if (!isGenuineFlip) continue;

      if (newImage.current_status !== "occupied") continue; // spec: unoccupied writes no-op here

      const spaceId = newImage.space_id as string;

      const result = await pool.query(
        `UPDATE bookings
         SET status = 'active'
         WHERE space_id = $1
           AND status = 'confirmed'
           AND NOW() BETWEEN start_time AND end_time
         RETURNING *`,
        [spaceId],
      );

      const booking = result.rows[0];
      if (!booking) continue; // no matching pending booking (already active, or a walk-in) — no-op per spec

      const spaceResult = await pool.query("SELECT * FROM spaces WHERE id = $1", [spaceId]);
      const space = spaceResult.rows[0];

      await sns.send(
        new PublishCommand({
          TopicArn: BOOKING_HONOURED_TOPIC_ARN,
          Message: JSON.stringify({ booking, space }),
          MessageAttributes: {
            event_type: { DataType: "String", StringValue: "booking-honoured" },
          },
        }),
      );
    } catch (err) {
      console.error("No-Show Resolver Lambda: failed to process record", err);
    }
  }
};