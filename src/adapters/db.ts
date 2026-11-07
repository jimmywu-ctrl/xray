import fs from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import type { Database as SqliteDatabase } from "better-sqlite3-multiple-ciphers";
import { resolveDb, type KeyStore } from "./keys.js";

/** Open an existing WeChat database without ever enabling writes. */
export function openDb(store: KeyStore, relativePath: string): SqliteDatabase | null {
  const resolved = resolveDb(store, relativePath);
  if (!resolved || !fs.existsSync(resolved.absPath)) return null;

  const db = new Database(resolved.absPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    // Configure SQLCipher before the first schema read; the key remains in memory.
    db.pragma("cipher='sqlcipher'");
    db.pragma("legacy=4");
    db.pragma(`key="x'${resolved.key.encKeyHex}'"`);
    db.pragma("query_only=ON");
    return db;
  } catch (cause) {
    db.close();
    throw cause;
  }
}

/** Resolve table existence using SQLite's parameterized catalog query. */
export function hasTable(db: SqliteDatabase, tableName: string): boolean {
  if (!tableName) return false;
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(tableName));
}
