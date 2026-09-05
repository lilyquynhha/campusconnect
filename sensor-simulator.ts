// Simulate occupancy sensors. Publish readings to sensors/{space_id}

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import mqtt from "mqtt";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Config ----
const BROKER_URL = "mqtt://localhost:1883";
const SENSOR_INTERVAL_MS = parseInt(
  process.env.SENSOR_INTERVAL_MS || "5000",
  10,
);
const ADDITIONAL_SENSOR = parseInt(process.env.ADDITIONAL_SENSOR || "0", 10);
const PERSISTENCE_PROBABILITY = 0.85; // chance a sensor keeps its current status in each new reading

type OccupancyStatus = "occupied" | "unoccupied";

// A space object in spaces.json - only id is needed here
interface SpaceRecord {
  id: string;
}

// A sensor reading
interface SensorState {
  sensorId: string;
  spaceId: string;
  status: OccupancyStatus;
}

// Load real space IDs
function loadRealSpaceIds(): string[] {
  const spacesPath = join(__dirname, "/database/spaces.json");
  const raw = readFileSync(spacesPath, "utf-8");
  const spaces: SpaceRecord[] = JSON.parse(raw);

  return spaces.map((s) => s.id);
}

// Generate synthetic, non-persisted IDs for load testing only
function generateSyntheticSpaceIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `LOAD-${String(i + 1).padStart(4, "0")}`, // format: LOAD-[id]
  );
}

// Generate a sensor reading for a specific space with a random status
function createSensorState(spaceId: string): SensorState {
  return {
    sensorId: `sensor-${spaceId}`,
    spaceId,
    status: Math.random() < 0.5 ? "occupied" : "unoccupied",
  };
}

// Make state mostly stable and flip occasionally
function nextStatus(current: OccupancyStatus): OccupancyStatus {
  if (Math.random() < PERSISTENCE_PROBABILITY) return current;
  return current === "occupied" ? "unoccupied" : "occupied";
}

function main(): void {
  // get all space IDs (both real + synthetic)
  const realSpaceIds = loadRealSpaceIds();
  const syntheticSpaceIds = generateSyntheticSpaceIds(ADDITIONAL_SENSOR);
  const allSpaceIds = [...realSpaceIds, ...syntheticSpaceIds];

  // initialise initial sensor states
  const sensors: SensorState[] = allSpaceIds.map(createSensorState);

  const client = mqtt.connect(BROKER_URL);

  client.on("connect", () => {
    console.log(
      `Connected to ${BROKER_URL}. Space IDs: ${realSpaceIds.length} real + ${syntheticSpaceIds.length} synthetic. Publish a reading every ${SENSOR_INTERVAL_MS}ms`,
    );

    setInterval(() => {
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
  });

  client.on("error", (err: Error) => {
    console.error("MQTT connection error:", err.message);
  });
}

main();
