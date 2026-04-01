import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const DEFAULT_DATABASE_URL = "postgresql://mcp:mcp@localhost:5432/mcp_docs_rag";

let pool = null;
let schemaReadyPromise = null;

function buildPoolConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
    };
  }

  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "mcp_docs_rag",
    user: process.env.PGUSER || "mcp",
    password: process.env.PGPASSWORD || "mcp",
  };
}

export function getDatabaseUrl() {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

export function getPool() {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
  }

  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function toVectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length === 0) {
    return null;
  }

  return `[${vector.map((value) => Number(value || 0)).join(",")}]`;
}

export function parseVector(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;

  const clean = String(value).trim();
  if (!clean.startsWith("[") || !clean.endsWith("]")) {
    return null;
  }

  return clean
    .slice(1, -1)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function listAppliedMigrations() {
  await ensureMigrationsTable();
  const result = await query("SELECT id FROM schema_migrations");
  return new Set(result.rows.map((row) => row.id));
}

async function applyMigration(filename) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
  await withTransaction(async (client) => {
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
      [filename]
    );
  });
}

export async function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      const applied = await listAppliedMigrations();
      const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((filename) => filename.endsWith(".sql"))
        .sort();

      for (const filename of files) {
        if (applied.has(filename)) continue;
        await applyMigration(filename);
      }
    })().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }

  return schemaReadyPromise;
}

export async function closePool() {
  if (!pool) return;
  const activePool = pool;
  pool = null;
  schemaReadyPromise = null;
  await activePool.end();
}
