import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, KEYS_FILE, autoDetectDbDir } from "./config.js";

export interface DbKey {
  rel: string;
  encKeyHex: string;
  salt: string;
}

export interface KeyStore {
  dbDir: string;
  byRel: Map<string, DbKey>;
}

function safeRelativePath(input: string): string | null {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function validAbsoluteDatabaseDir(value: string | undefined): value is string {
  return Boolean(value && path.isAbsolute(value) && fs.existsSync(path.join(value, "message")));
}

function readLocalDirectoryOverride(): string | undefined {
  const envValue = process.env.WECHAT_DB_DIR?.trim();
  if (envValue) return envValue;
  try {
    return fs.readFileSync(path.join(DATA_DIR, "wechat-db-path.txt"), "utf8")
      .replace(/^\uFEFF/, "")
      .trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseKeyStore(file: string): { byRel: Map<string, DbKey>; configuredDir?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`无法读取微信数据库密钥文件：${file}`, { cause });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("微信密钥文件格式无效：顶层必须是对象。");
  }

  const byRel = new Map<string, DbKey>();
  let configuredDir: string | undefined;
  for (const [inputPath, value] of Object.entries(raw)) {
    if (inputPath === "_db_dir") {
      if (typeof value === "string") configuredDir = value.trim();
      continue;
    }
    if (inputPath.startsWith("_")) continue;
    const rel = safeRelativePath(inputPath);
    if (!rel || !value || typeof value !== "object") {
      throw new Error(`数据库密钥条目格式无效：${inputPath}`);
    }
    const entry = value as { enc_key?: unknown; salt?: unknown };
    if (typeof entry.enc_key !== "string" || !/^[\da-f]{64}$/i.test(entry.enc_key)
      || typeof entry.salt !== "string" || !/^[\da-f]{32}$/i.test(entry.salt)) {
      throw new Error(`数据库密钥或 salt 格式不完整：${inputPath}`);
    }
    byRel.set(rel, {
      rel,
      encKeyHex: entry.enc_key.toLowerCase(),
      salt: entry.salt.toLowerCase(),
    });
  }
  return { byRel, configuredDir };
}

function verifyDatabaseBelongsToKey(file: string, expectedSalt: string): void {
  if (!fs.existsSync(file)) return;
  const fd = fs.openSync(file, "r");
  const header = Buffer.alloc(16);
  let read = 0;
  try {
    read = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (read !== header.length || header.toString("hex") !== expectedSalt) {
    throw new Error("已保存的微信数据库密钥与当前数据库不匹配，请在这台电脑重新提取密钥。");
  }
}

export function loadKeys(): KeyStore {
  if (!fs.existsSync(KEYS_FILE)) {
    throw new Error(`未找到微信密钥文件：${KEYS_FILE}\n请在设置中提取密钥或选择密钥文件。`);
  }
  const parsed = parseKeyStore(KEYS_FILE);
  if (parsed.byRel.size === 0) throw new Error("密钥文件没有可用的数据库密钥。");

  const override = readLocalDirectoryOverride();
  const dbDir = (validAbsoluteDatabaseDir(override) ? override : undefined)
    ?? (validAbsoluteDatabaseDir(parsed.configuredDir) ? parsed.configuredDir : undefined)
    ?? autoDetectDbDir()
    ?? "";
  if (!dbDir) {
    throw new Error("找不到微信数据库目录。请在设置中指定数据目录，或确认密钥文件包含 _db_dir。");
  }

  for (const key of parsed.byRel.values()) {
    verifyDatabaseBelongsToKey(path.join(dbDir, ...key.rel.split("/")), key.salt);
  }
  return { dbDir, byRel: parsed.byRel };
}

export function resolveDb(store: KeyStore, relativePath: string): { absPath: string; key: DbKey } | null {
  const rel = safeRelativePath(relativePath);
  if (!rel) return null;
  const key = store.byRel.get(rel);
  if (!key) return null;

  const base = path.resolve(store.dbDir);
  const absPath = path.resolve(base, ...rel.split("/"));
  const fromBase = path.relative(base, absPath);
  if (fromBase === ".." || fromBase.startsWith(`..${path.sep}`) || path.isAbsolute(fromBase)) return null;
  return { absPath, key };
}

export function messageDbKeys(store: KeyStore): DbKey[] {
  return [...store.byRel.values()]
    .filter(({ rel }) => /(^|\/)message\/message_\d+\.db$/i.test(rel))
    .sort((a, b) => a.rel.localeCompare(b.rel, "en", { numeric: true, sensitivity: "base" }));
}
