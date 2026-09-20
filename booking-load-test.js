/**
 * CampusConnect — Phase 8 load test (k6)
 *
 * Three scenarios running together, all against the naive Booking API:
 *   1. search_traffic   — background GET /spaces/search load
 *   2. booking_load      — general booking creation, one distinct student
 *                          per iteration so 409s from real conflicts stay
 *                          rare and the latency data reflects genuine
 *                          creation cost, not artificial contention
 *   3. collision_burst   — many VUs POST the exact same space/time slot at
 *                          once, deliberately forcing the naive check-then-
 *                          insert race condition (see booking-api.ts)
 *
 * Prerequisite: run seed-load-students.sql against your DB first (adds
 * ~1850 load-test-only students in the student-load-* ID range).
 *
 * IMPORTANT — pass COLLISION_START/COLLISION_END explicitly on every run.
 * They default to "2 days from whenever the test happens to start,"
 * rounded to the hour, which is safely inside the 5-day advance-booking
 * rule — but a computed default means you won't know the exact value in
 * advance to write your post-run correctness query against. Compute it
 * yourself first and pass it in, e.g.:
 *
 *   COLLISION_START=$(date -u -d "+2 days" +"%Y-%m-%dT%H:00:00Z")
 *   COLLISION_END=$(date -u -d "+2 days 1 hour" +"%Y-%m-%dT%H:00:00Z")
 *
 * Run (VU counts are all overridable — see options below):
 *   k6 run --env BASE_URL=http://<EC2_PUBLIC_IP>:3000 \
 *          --env COLLISION_START=$COLLISION_START \
 *          --env COLLISION_END=$COLLISION_END \
 *          --env BOOKING_VUS=20 --env SEARCH_VUS=20 --env COLLISION_VUS=50 \
 *          --out csv=results.csv --summary-export=summary.json \
 *          booking-load-test.js
 *
 * Stage durations are intentionally fixed across runs (only VU targets are
 * parameterized) — Run 3 in the test plan varies concurrency, not duration,
 * so holding duration constant keeps that comparison valid.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

const BOOKING_VUS = parseInt(__ENV.BOOKING_VUS || "20", 10);
const SEARCH_VUS = parseInt(__ENV.SEARCH_VUS || "20", 10);
const COLLISION_VUS = parseInt(__ENV.COLLISION_VUS || "50", 10);

const COLLISION_SPACE_ID = __ENV.COLLISION_SPACE_ID || "A-1-01";

// Mirrors spaces.json's ID format (5 buildings x 2 levels x 10 rooms).
// Kept inline so this script has no file dependency — regenerate this list
// if spaces.json's shape ever changes.
const REAL_SPACE_IDS = new SharedArray("spaces", function () {
  const ids = [];
  const buildings = ["A", "B", "C", "D", "E"];
  for (const b of buildings) {
    for (let level = 1; level <= 2; level++) {
      for (let room = 1; room <= 10; room++) {
        ids.push(`${b}-${level}-${String(room).padStart(2, "0")}`);
      }
    }
  }
  return ids;
});

function randomSpaceId() {
  return REAL_SPACE_IDS[Math.floor(Math.random() * REAL_SPACE_IDS.length)];
}

// Random valid future slot: 1 hour to 4.5 days out, 1-5 hour duration —
// comfortably inside the business rules so these don't fail validation.
function randomBookingWindow() {
  const now = Date.now();
  const startOffsetMs =
    Math.floor(Math.random() * 4.5 * 24 * 60 * 60 * 1000) + 60 * 60 * 1000;
  const durationHours = 1 + Math.floor(Math.random() * 5);
  const start = new Date(now + startOffsetMs);
  const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

// Bounded to the 1800-student general pool from seed-load-students.sql.
function generalStudentId(vu, iter) {
  const index = (vu * 1000 + iter) % 1800;
  return `student-load-${String(index).padStart(4, "0")}`;
}

// Separate 50-student reserve, so the collision burst never touches the
// general pool's students. Bounded to COLLISION_VUS so raising that count
// stays within the seeded student-load-collision-* range (max 50 seeded).
function collisionStudentId(vu) {
  return `student-load-collision-${String(vu % 50).padStart(3, "0")}`;
}

// Computed once (not per-VU) so every VU in collision_burst uses the exact
// same window regardless of when each VU's init code happens to run.
export function setup() {
  let start, end;

  if (__ENV.COLLISION_START && __ENV.COLLISION_END) {
    start = __ENV.COLLISION_START;
    end = __ENV.COLLISION_END;
  } else {
    // Fallback default: 2 days from now, rounded to the hour, 1hr duration.
    // Safely inside the 5-day advance limit regardless of when this runs —
    // but see the file header: pass these explicitly so you know the exact
    // value in advance for your correctness query.
    const base = new Date();
    base.setUTCMinutes(0, 0, 0);
    const startDate = new Date(base.getTime() + 2 * 24 * 60 * 60 * 1000);
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    start = startDate.toISOString();
    end = endDate.toISOString();
  }

  console.log(
    `[setup] collision window: ${start} -> ${end} (space ${COLLISION_SPACE_ID})`,
  );
  return { collisionStart: start, collisionEnd: end };
}

export const options = {
  scenarios: {
    search_traffic: {
      executor: "ramping-vus",
      exec: "searchSpaces",
      startVUs: 0,
      stages: [
        { duration: "30s", target: SEARCH_VUS },
        { duration: "1m", target: SEARCH_VUS },
        { duration: "30s", target: 0 },
      ],
    },
    booking_load: {
      executor: "ramping-vus",
      exec: "createBooking",
      startVUs: 0,
      stages: [
        { duration: "30s", target: BOOKING_VUS },
        { duration: "1m", target: BOOKING_VUS },
        { duration: "30s", target: 0 },
      ],
    },
    collision_burst: {
      executor: "per-vu-iterations",
      exec: "createCollisionBooking",
      vus: COLLISION_VUS,
      iterations: 1,
      startTime: "45s", // fires once general load is already ramped up
      maxDuration: "30s",
    },
  },
};

export function searchSpaces() {
  const { start, end } = randomBookingWindow();
  const res = http.get(
    `${BASE_URL}/spaces/search?start_time=${start}&end_time=${end}`,
  );
  check(res, { "search status 200": (r) => r.status === 200 });
  sleep(1);
}

export function createBooking() {
  const { start, end } = randomBookingWindow();
  const payload = JSON.stringify({
    student_id: generalStudentId(__VU, __ITER),
    space_id: randomSpaceId(),
    start_time: start,
    end_time: end,
  });
  const res = http.post(`${BASE_URL}/bookings`, payload, {
    headers: { "Content-Type": "application/json" },
  });
  // 409 is an expected outcome under load (real conflicts happen) — only a
  // 5xx or timeout represents an actual failure worth flagging.
  check(res, { "booking did not 5xx": (r) => r.status < 500 });
  sleep(1);
}

export function createCollisionBooking(data) {
  const payload = JSON.stringify({
    student_id: collisionStudentId(__VU),
    space_id: COLLISION_SPACE_ID,
    start_time: data.collisionStart,
    end_time: data.collisionEnd,
  });
  const res = http.post(`${BASE_URL}/bookings`, payload, {
    headers: { "Content-Type": "application/json" },
  });
  check(res, {
    "collision responded": (r) => r.status === 200 || r.status === 409,
  });
}
