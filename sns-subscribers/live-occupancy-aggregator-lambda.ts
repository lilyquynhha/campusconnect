/**
 * CampusConnect — Live-Occupancy Aggregator Lambda
 *
 * Trigger: DynamoDB Streams on the SpaceState table — same stream as the
 * No-Show Resolver, a separate event source mapping and a separate
 * function (per spec Section 7c: "separate consumer, same stream").
 *
 * No VPC attachment needed: this Lambda never touches RDS, only DynamoDB,
 * so it uses the default (non-VPC) Lambda network path to reach it over
 * DynamoDB's public AWS API — no Gateway Endpoint required for this one.
 */

import { DynamoDBStreamEvent } from "aws-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      if (!record.dynamodb?.NewImage) continue;

      const newImage = unmarshall(record.dynamodb.NewImage as any);
      const oldImage = record.dynamodb.OldImage
        ? unmarshall(record.dynamodb.OldImage as any)
        : null;

      const oldStatus = oldImage?.current_status;
      const newStatus = newImage.current_status;
      if (oldStatus === newStatus) continue; // heartbeat write, no actual flip — nothing to adjust

      let delta = 0;
      if (newStatus === "occupied") delta = 1;
      else if (newStatus === "unoccupied" && oldStatus === "occupied")
        delta = -1;
      if (delta === 0) continue;

      const { building, level } = newImage;

      await ddb.send(
        new UpdateCommand({
          TableName: "BuildingLevelCrowding",
          Key: { building, level },
          UpdateExpression:
            "SET occupied_count = if_not_exists(occupied_count, :zero) + :delta, last_updated = :now",
          ExpressionAttributeValues: {
            ":delta": delta,
            ":zero": 0,
            ":now": new Date().toISOString(),
          },
        }),
      );
    } catch (err) {
      console.error(
        "Live-Occupancy Aggregator Lambda: failed to process record",
        err,
      );
    }
  }
};
