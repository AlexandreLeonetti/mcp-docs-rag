import "dotenv/config";
import { closePool, ensureSchema, getDatabaseUrl } from "./client.js";

await ensureSchema();
console.log(`Database schema ready: ${getDatabaseUrl()}`);
await closePool();
