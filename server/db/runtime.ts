import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { initSchema } from "./schema.js";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath =
    process.env.DB_PATH ||
    path.join(process.cwd(), "pixel-claw-dashboard.sqlite");

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
