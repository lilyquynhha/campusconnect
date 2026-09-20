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
 * Run:
 *   k6 run --env BASE_URL=http://<EC2_PUBLIC_IP>:3000 \
 *          --out csv=results.csv --summary-export=summary.json \
 *          booking-load-test.js
 *
 * Adjust the `stages` below between runs to find the breakpoint — this is
 * the HTTP side of the ramp; increase ADDITIONAL_SENSOR / shrink
 * SENSOR_INTERVAL_MS on the sensor simulator at the same time to also load
 * the shared Postgres connection pool from the sensor-write side.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Every VU in collision_burst books this exact slot — the fixed contention
// point that forces the race.
const COLLISION_SPACE_ID = __ENV.COLLISION_SPACE_ID || 'A-1-01';
const COLLISION_START = __ENV.COLLISION_START || '2026-09-25T09:00:00Z';
const COLLISION_END = __ENV.COLLISION_END || '2026-09-25T10:00:00Z';

// Mirrors spaces.json's ID format (5 buildings x 2 levels x 10 rooms).
// Kept inline so this script has no file dependency — regenerate this list
// if spaces.json's shape ever changes.
const REAL_SPACE_IDS = new SharedArray('spaces', function () {
  const ids = [];
  const buildings = ['A', 'B', 'C', 'D', 'E'];
  for (const b of buildings) {
    for (let level = 1; level <= 2; level++) {
      for (let room = 1; room <= 10; room++) {
        ids.push(`${b}-${level}-${String(room).padStart(2, '0')}`);
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
  const startOffsetMs = Math.floor(Math.random() * 4.5 * 24 * 60 * 60 * 1000) + 60 * 60 * 1000;
  const durationHours = 1 + Math.floor(Math.random() * 5);
  const start = new Date(now + startOffsetMs);
  const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

// Bounded to the 1800-student general pool from seed-load-students.sql.
function generalStudentId(vu, iter) {
  const index = (vu * 1000 + iter) % 1800;
  return `student-load-${String(index).padStart(4, '0')}`;
}

// Separate 50-student reserve, so the collision burst never touches the
// general pool's students.
function collisionStudentId(vu) {
  return `student-load-collision-${String(vu).padStart(3, '0')}`;
}

export const options = {
  scenarios: {
    search_traffic: {
      executor: 'ramping-vus',
      exec: 'searchSpaces',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 20 },
        { duration: '30s', target: 0 },
      ],
    },
    booking_load: {
      executor: 'ramping-vus',
      exec: 'createBooking',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 20 },
        { duration: '30s', target: 0 },
      ],
    },
    collision_burst: {
      executor: 'per-vu-iterations',
      exec: 'createCollisionBooking',
      vus: 50,
      iterations: 1,
      startTime: '45s', // fires once general load is already ramped up
      maxDuration: '30s',
    },
  },
};

export function searchSpaces() {
  const { start, end } = randomBookingWindow();
  const res = http.get(`${BASE_URL}/spaces/search?start_time=${start}&end_time=${end}`);
  check(res, { 'search status 200': (r) => r.status === 200 });
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
    headers: { 'Content-Type': 'application/json' },
  });
  // 409 is an expected outcome under load (real conflicts happen) — only a
  // 5xx or timeout represents an actual failure worth flagging.
  check(res, { 'booking did not 5xx': (r) => r.status < 500 });
  sleep(1);
}

export function createCollisionBooking() {
  const payload = JSON.stringify({
    student_id: collisionStudentId(__VU),
    space_id: COLLISION_SPACE_ID,
    start_time: COLLISION_START,
    end_time: COLLISION_END,
  });
  const res = http.post(`${BASE_URL}/bookings`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'collision responded': (r) => r.status === 200 || r.status === 409 });
}