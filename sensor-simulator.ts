/**
 * CampusConnect — Simulated Occupancy Sensors (TypeScript / ESM)
 *
 * Publishes an occupancy reading every SENSOR_INTERVAL_MS to MQTT topic
 * `sensors/{space_id}`. Payload: { sensor_id, space_id, status, timestamp }
 *
 * Real space IDs are read from spaces.json (the same file schema.sql/seed.sql
 * are generated from), so the sensor list can never drift from the DB.
 *
 * ADDITIONAL_SENSOR controls how many extra *synthetic* sensors are simulated
 * on top of the real 100 spaces, for load-testing the space_status write path
 * (Phase 8). Synthetic IDs use a distinct 'LOAD-' prefix and are never real
 * spaces — they exist purely to generate write volume against Postgres.
 *
 * Setup:
 *   npm install mqtt
 *   npx tsx sensor-simulator.ts              # requires tsx or ts-node (ESM)
 *
 * Load-test ramp (Phase 8 — override via env vars, no code changes needed):
 *   ADDITIONAL_SENSOR=4900 SENSOR_INTERVAL_MS=1000 npx tsx sensor-simulator.ts
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mqtt from 'mqtt';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Config ----
const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const SENSOR_INTERVAL_MS = parseInt(process.env.SENSOR_INTERVAL_MS || '5000', 10);
const ADDITIONAL_SENSOR = parseInt(process.env.ADDITIONAL_SENSOR || '0', 10);
const PERSISTENCE_PROBABILITY = 0.85; // chance a sensor keeps its current status each tick

type OccupancyStatus = 'occupied' | 'unoccupied';

interface SpaceRecord {
  id: string;
}

interface SensorState {
  sensorId: string;
  spaceId: string;
  status: OccupancyStatus;
}

// ---- Load real space IDs from the shared seed file ----
function loadRealSpaceIds(): string[] {
  const spacesPath = join(__dirname, 'spaces.json');
  const raw = readFileSync(spacesPath, 'utf-8');
  const spaces: SpaceRecord[] = JSON.parse(raw);
  return spaces.map((s) => s.id);
}

// ---- Generate synthetic, non-persisted IDs for load testing only ----
function generateSyntheticSpaceIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `LOAD-${String(i + 1).padStart(4, '0')}`);
}

function createSensorState(spaceId: string): SensorState {
  return {
    sensorId: `sensor-${spaceId}`,
    spaceId,
    status: Math.random() < 0.5 ? 'occupied' : 'unoccupied',
  };
}

// Each sensor remembers its last status so occupancy looks realistic (mostly
// stable, occasionally flips) instead of pure noise — this matters because
// the debounce logic downstream is a majority vote over the last 5 readings.
function nextStatus(current: OccupancyStatus): OccupancyStatus {
  if (Math.random() < PERSISTENCE_PROBABILITY) return current;
  return current === 'occupied' ? 'unoccupied' : 'occupied';
}

function main(): void {
  const realSpaceIds = loadRealSpaceIds();
  const syntheticSpaceIds = generateSyntheticSpaceIds(ADDITIONAL_SENSOR);
  const allSpaceIds = [...realSpaceIds, ...syntheticSpaceIds];

  const sensors: SensorState[] = allSpaceIds.map(createSensorState);

  const client = mqtt.connect(BROKER_URL);

  client.on('connect', () => {
    console.log(
      `Connected to ${BROKER_URL} — ${realSpaceIds.length} real spaces + ${syntheticSpaceIds.length} synthetic, ${SENSOR_INTERVAL_MS}ms interval`
    );

    const timer = setInterval(() => {
      const timestamp = new Date().toISOString();

      for (const sensor of sensors) {
        sensor.status = nextStatus(sensor.status);

        const topic = `sensors/${sensor.spaceId}`;
        const payload = JSON.stringify({
          sensor_id: sensor.sensorId,
          space_id: sensor.spaceId,
          status: sensor.status,
          timestamp,
        });

        client.publish(topic, payload);
      }
    }, SENSOR_INTERVAL_MS);

    process.on('SIGINT', () => {
      console.log('\nShutting down sensor simulator...');
      clearInterval(timer);
      client.end(() => process.exit(0));
    });
  });

  client.on('error', (err: Error) => {
    console.error('MQTT connection error:', err.message);
  });
}

main();