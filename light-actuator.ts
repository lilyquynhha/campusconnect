// Simulate turning room lighting on/off

import mqtt from "mqtt";

const BROKER_URL = "mqtt://localhost:1883";

type LightState = "on" | "off";

const lastKnownState = new Map<string, LightState>(); // stores last know state of a light

// Extract space ID from topic "light/{space_id}"
function extractSpaceId(topic: string): string | null {
  const parts = topic.split("/");
  if (parts.length !== 2 || parts[0] !== "light") return null;
  return parts[1];
}

function main(): void {
  const client = mqtt.connect(BROKER_URL);

  client.on("connect", () => {
    console.log(`Connected to ${BROKER_URL}. Listening on light/+`);
    client.subscribe("light/+");
  });

  client.on("message", (topic, payload) => {
    const spaceId = extractSpaceId(topic);
    if (!spaceId) return;

    // simulate turning light on/off
    const newState = payload.toString();
    const previousState = lastKnownState.get(spaceId);
    if (newState !== previousState) {
      lastKnownState.set(spaceId, newState as LightState);
      console.log(`Turning the light ${newState} for space id ${spaceId}`);
    }
  });

  client.on("error", (err: Error) => {
    console.error("MQTT connection error:", err.message);
  });
}

main();
