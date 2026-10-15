// Prints a DEV-ONLY Ed25519 key pair as env lines. Never use these for anything real.
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
console.log("# DEV ONLY owner signing keys (Ed25519, base64 DER). Synthetic demo; never use for anything real.");
console.log(`OWNER_SIGNING_PRIVATE_KEY=${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")}`);
console.log(`OWNER_SIGNING_PUBLIC_KEY=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`);
