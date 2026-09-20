#!/bin/bash
# CampusConnect — SNS topic setup.
# Creating all four now (not just booking-confirmed) because they're cheap,
# static, and this avoids re-running a setup script later when step 4/6
# subscribers are added — only the *subscriptions* are step-4/6 work, not
# the topics themselves.
#
# Topics, per final-specs-v2.md Section 8:
#   booking-confirmed    -> Notification, Analytics, Door-Display (step 4)
#   booking-not-honoured -> Notification, Analytics, Door-Display (step 5, Housekeeping Lambda)
#   booking-honoured     -> Notification (optional), Door-Display (step 5, No-Show Resolver Lambda)
#   booking-cancelled    -> Analytics, Door-Display only, NOT Notification (step 6)

set -euo pipefail

REGION="us-east-1"

for TOPIC in booking-confirmed booking-not-honoured booking-honoured booking-cancelled; do
  echo "Creating topic: $TOPIC"
  ARN=$(aws sns create-topic --region "$REGION" --name "$TOPIC" --query "TopicArn" --output text)
  echo "  -> $ARN"
done

echo
echo "Save these ARNs — the Booking Lambda's env vars need BOOKING_CONFIRMED_TOPIC_ARN"
echo "now; the rest are used when their respective consumer Lambdas are wired up."