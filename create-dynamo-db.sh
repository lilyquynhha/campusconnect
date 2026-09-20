#!/bin/bash
# CampusConnect — DynamoDB table setup for the scalable solution.
# Run once against your AWS account (Learner Lab / Free Tier). Idempotent
# re-runs will fail with "Table already exists" — that's expected, not a bug.
#
# Two tables, matching the two DynamoDB Streams consumers in final-specs-v2.md
# Section 7a/7c (No-Show Resolver, Live-Occupancy Aggregator):
#
# 1. SpaceState — one item per space, written by Node-RED on every 5s
#    sensor reading (per spec Section 2a). building/level are denormalized
#    onto this item (not looked up from Postgres) specifically so the live
#    presence path never depends on the booking database — that's the
#    whole point of the two-store split in the spec. Node-RED already has
#    the space hierarchy locally, so this costs nothing to populate.
#
# 2. BuildingLevelCrowding — one item per building+level, maintained by the
#    Aggregator Lambda off the SpaceState stream (spec Section 7c). Uses
#    building as partition key and level as sort key (not a single
#    concatenated string) so the Facilities Dashboard can also query "every
#    level in building X" in one request if that view is ever needed,
#    without changing the key schema later.
#
# Both tables use PAY_PER_REQUEST billing rather than provisioned capacity:
# sensor write volume is exactly the kind of bursty, hard-to-predict load
# (scales with however many sensors + load-test VUs are running) that
# provisioned throughput would force you to guess at — and mis-guessing
# either throttles writes (defeating the point of moving off Postgres) or
# over-provisions past what's needed for a class project. On-demand also
# stays within DynamoDB's Always-Free allowances for this workload.

set -euo pipefail

REGION="us-east-1"

echo "Creating SpaceState table..."
aws dynamodb create-table \
  --region "$REGION" \
  --table-name SpaceState \
  --attribute-definitions \
      AttributeName=space_id,AttributeType=S \
  --key-schema \
      AttributeName=space_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES

# NEW_AND_OLD_IMAGES (not just NEW_IMAGE) because the Aggregator Lambda
# needs the OLD current_status to decrement the previous building/level's
# count when a space's status flips — NEW alone only tells you where a
# space ended up, not where it came from. The No-Show Resolver only needs
# the new image, but both Lambdas subscribe to this same stream, so the
# view type is set for the more demanding consumer.

echo "Creating BuildingLevelCrowding table..."
aws dynamodb create-table \
  --region "$REGION" \
  --table-name BuildingLevelCrowding \
  --attribute-definitions \
      AttributeName=building,AttributeType=S \
      AttributeName=level,AttributeType=N \
  --key-schema \
      AttributeName=building,KeyType=HASH \
      AttributeName=level,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

echo "Waiting for both tables to become ACTIVE..."
aws dynamodb wait table-exists --region "$REGION" --table-name SpaceState
aws dynamodb wait table-exists --region "$REGION" --table-name BuildingLevelCrowding

echo "Done. SpaceState item shape:"
echo '  { space_id (PK), current_status, last_changed_at, last_seen_at, building, level }'
echo "BuildingLevelCrowding item shape:"
echo '  { building (PK), level (SK), occupied_count, last_updated }'