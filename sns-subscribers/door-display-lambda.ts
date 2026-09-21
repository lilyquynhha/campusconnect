/**
 * CampusConnect — Door-Display Lambda
 *
 * Subscribed to: booking-confirmed, booking-not-honoured, booking-honoured,
 * booking-cancelled — every event type that should change what a door
 * display shows.
 *
 * Stubbed rather than actually publishing to the local MQTT broker: the
 * naive version's EC2-to-local reverse SSH tunnel was judged too fragile
 * to depend on for this Lambda, so this logs the exact MQTT topic/payload
 * it would have published instead. The naive version's inline
 * `publishDoorDisplay()` call is still the reference for topic naming
 * (`display/{space_id}`) if a real MQTT client is wired in later.
 */

import { SNSEvent } from "aws-lambda";

interface DisplayPayload {
  booking?: { student_id?: string };
  space: { id: string };
}

function displayMessageFor(eventType: string, spaceId: string): string {
  switch (eventType) {
    case "booking-confirmed":
      return `${spaceId} booked.`;
    case "booking-not-honoured":
    case "booking-honoured":
    case "booking-cancelled":
    case "booking-ended":
      return `${spaceId} available`;
    default:
      return `${spaceId} status unknown`;
  }
}

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    const eventType =
      record.Sns.MessageAttributes?.event_type?.Value ?? "unknown";

    try {
      const { space } = JSON.parse(record.Sns.Message) as DisplayPayload;
      const topic = `display/${space.id}`;
      const message = displayMessageFor(eventType, space.id);

      console.log(`[stub mqtt publish] topic="${topic}" message="${message}"`);
    } catch (err) {
      console.error("Door-Display Lambda: failed to process record", err);
    }
  }
};
