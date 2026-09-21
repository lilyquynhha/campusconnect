/**
 * CampusConnect — Notification Lambda
 *
 * Subscribed to: booking-confirmed, booking-not-honoured, booking-honoured.
 *
 * Stubbed, same reasoning as the naive version's sendConfirmationEmailStub:
 * SES sandbox mode requires verifying every sender/recipient address first,
 * which is setup overhead unrelated to what this Lambda is meant to
 * demonstrate — that SNS fan-out actually decouples notification from the
 * booking request/response path. The call site is shaped so swapping in a
 * real `SESClient.send(...)` later is a one-function change, not a rewrite.
 */

import { SNSEvent } from "aws-lambda";

interface BookingPayload {
  booking: { student_id: string; start_time: string };
  space: { id: string };
}

async function sendEmailStub(
  eventType: string,
  studentId: string,
  spaceId: string,
  startTime: string,
): Promise<void> {
  console.log(
    `[stub email] ${eventType} -> ${studentId} for space ${spaceId} at ${startTime}`,
  );
}

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    const eventType =
      record.Sns.MessageAttributes?.event_type?.Value ?? "unknown";

    try {
      const { booking, space } = JSON.parse(
        record.Sns.Message,
      ) as BookingPayload;

      await sendEmailStub(
        eventType,
        booking.student_id,
        space.id,
        booking.start_time,
      );
    } catch (err) {
      console.error("Notification Lambda: failed to process record", err);
    }
  }
};
