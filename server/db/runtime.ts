import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { initSchema } from "./schema.js";

const STATE_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".local/state/pixel-claw-dashboard",
);
const PROD_DB = path.join(STATE_DIR, "prod/pixel-claw-dashboard.sqlite");

let db: DatabaseSync | null = null;

/**
 * When running in preview mode (port 8792), snapshot the prod DB
 * so that preview tests against real data without mutating prod.
 */
function mirrorProdToPreview(previewDbPath: string): void {
  if (process.env.PORT !== "8792") return;
  if (!fs.existsSync(PROD_DB)) return;
  if (previewDbPath === PROD_DB) return;

  // Checkpoint WAL into main file before copying
  try {
    const src = new DatabaseSync(PROD_DB, { readOnly: true } as never);
    try { src.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* ignore */ }
    src.close();
  } catch { /* ignore — read-only or locked */ }

  fs.mkdirSync(path.dirname(previewDbPath), { recursive: true });
  fs.copyFileSync(PROD_DB, previewDbPath);

  // Remove stale WAL/SHM from previous preview run
  for (const suffix of ["-wal", "-shm"]) {
    try { fs.unlinkSync(previewDbPath + suffix); } catch { /* ignore */ }
  }

  console.log(`[db] Mirrored prod DB → preview (${path.basename(previewDbPath)})`);
}

export function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath =
    process.env.DB_PATH ||
    path.join(process.cwd(), "pixel-claw-dashboard.sqlite");

  mirrorProdToPreview(dbPath);

  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  initSchema(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
