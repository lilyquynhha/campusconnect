#!/bin/bash
# CampusConnect — API Gateway (HTTP API) setup for the BookingAPI Lambda.
#
# Uses the "quick create" form of `create-api`, which in one call sets up:
#   - the HTTP API itself
#   - a Lambda proxy integration to BookingAPI
#   - a catch-all $default route (ANY /{proxy+})
#   - a $default stage with auto-deploy enabled
#   - the Lambda resource-based permission allowing this API to invoke it
#   - CORS preflight handling for browser clients

set -euo pipefail

REGION="us-east-1"
LAMBDA_ARN="arn:aws:lambda:us-east-1:547123020998:function:BookingAPI"

echo "Creating HTTP API targeting $LAMBDA_ARN with CORS enabled..."
API_ID=$(aws apigatewayv2 create-api \
  --region "$REGION" \
  --name CampusConnectBookingAPI \
  --protocol-type HTTP \
  --target "$LAMBDA_ARN" \
  --cors-configuration "AllowOrigins=[\"*\"],AllowMethods=[\"GET\",\"POST\",\"PUT\",\"DELETE\",\"OPTIONS\"],AllowHeaders=[\"Content-Type\",\"Authorization\",\"X-Amz-Date\",\"X-Api-Key\",\"X-Amz-Security-Token\"],MaxAge=300" \
  --query "ApiId" \
  --output text)

INVOKE_URL=$(aws apigatewayv2 get-api \
  --region "$REGION" \
  --api-id "$API_ID" \
  --query "ApiEndpoint" \
  --output text)

echo
echo "API created: $API_ID"
echo "Invoke URL:  $INVOKE_URL"
echo
echo "Auto-deploy is on for the \$default stage — no separate deploy step,"
echo "and no manual permission grant needed, quick-create already added it."
echo
echo "Quick smoke test once this finishes:"
echo "  curl \"$INVOKE_URL/spaces/search?start_time=2026-09-22T09:00:00Z&end_time=2026-09-22T10:00:00Z\""