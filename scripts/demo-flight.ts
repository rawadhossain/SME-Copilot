// Creates the dedicated SYNTHETIC business for the flight-simulator demo and prints how to use it. Run: bun run demo:flight
// Additive only: a new flagged clone is created each time; nothing is reset or deleted.
import { createFlightDemo } from "./flight-fixture";

const d = await createFlightDemo();
const gbp = (m: bigint) => `${m / 100n}.${String(m % 100n).padStart(2, "0")}`;
console.log(`Created: ${d.name}`);
console.log(`  id ${d.id}`);
console.log(`  cushion ${gbp(d.reserveMinor)} GBP; lowest balance in the forecast today ${gbp(d.lowestMinor)} GBP (healthy, thin)`);
console.log("Next: bun run demo, sign in as the owner, choose this company in the top bar, open Simulator. Steps: docs/flight-simulator-demo.md");
