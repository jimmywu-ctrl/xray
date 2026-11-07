import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SETUP_KEYS_SCRIPT = path.resolve(APP_ROOT, "../../scripts/setup-keys.ps1");

function applicationDataRoot(env: NodeJS.ProcessEnv, home = os.homedir()): string {
  return env.XRAY_DATA_DIR?.trim() || path.join(
    env.APPDATA || path.join(home, "AppData", "Roaming"),
    "xray-next",
  );
}

/** Runtime state stays outside the installed application so updates cannot overwrite it. */
export const DATA_DIR = applicationDataRoot(process.env);
export const SECRETS_DIR = path.join(DATA_DIR, "secrets");
export const KEYS_FILE = path.join(SECRETS_DIR, "all_keys.json");

export interface WechatDbPathCheck {
  source: string;
  rootExists: boolean;
  xwechatFilesExists: boolean;
  accountDirectories: number;
  dbStorageDirectories: number;
  messageDirectories: number;
  sampleDbDir: string | null;
  accessError: boolean;
}

export interface WechatDbDiscoveryDiagnostics {
  configFiles: number;
  checks: WechatDbPathCheck[];
  detectedDbDir: string | null;
}

function exists(filename: string): boolean {
  try { return fs.existsSync(filename); }
  catch { return false; }
}

function isDirectory(filename: string): boolean {
  try { return fs.statSync(filename).isDirectory(); }
  catch { return false; }
}

function normalizedPathKey(filename: string): string {
  return path.resolve(filename).replace(/[\\/]+$/, "").toLowerCase();
}

function validDatabaseDirectory(filename: string): boolean {
  return path.isAbsolute(filename) && isDirectory(filename) && exists(path.join(filename, "message"));
}

function configuredDatabaseDirectory(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  const explicit = env.WECHAT_DB_DIR?.trim();
  if (explicit && validDatabaseDirectory(explicit)) return path.resolve(explicit);

  const dataDir = applicationDataRoot(env, homeDir);
  try {
    const saved = fs.readFileSync(path.join(dataDir, "wechat-db-path.txt"), "utf8")
      .replace(/^\uFEFF/, "")
      .trim();
    if (saved && validDatabaseDirectory(saved)) return path.resolve(saved);
  } catch {
    // The override is optional; continue with normal discovery.
  }
  return null;
}

function configuredRoots(appData: string, homeDir: string, env: NodeJS.ProcessEnv): {
  roots: Array<{ source: string; root: string }>;
  configFiles: number;
} {
  const roots: Array<{ source: string; root: string }> = [];
  const seen = new Set<string>();
  let configFiles = 0;
  const add = (source: string, root: string) => {
    const key = normalizedPathKey(root);
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ source, root });
  };

  const configDir = path.join(appData, "Tencent", "xwechat", "config");
  if (exists(configDir)) {
    try {
      for (const filename of fs.readdirSync(configDir)) {
        if (!filename.toLowerCase().endsWith(".ini")) continue;
        try {
          const bytes = fs.readFileSync(path.join(configDir, filename));
          configFiles++;
          for (const text of [bytes.toString("utf8"), bytes.toString("utf16le")]) {
            for (const line of text.replace(/^\uFEFF/, "").split(/[\r\n\0]+/)) {
              const separator = line.indexOf("=");
              const candidate = (separator >= 0 ? line.slice(separator + 1) : line)
                .trim()
                .replace(/^"|"$/g, "");
              if (path.isAbsolute(candidate) && !candidate.includes("\uFFFD")) add("微信配置文件", candidate);
            }
          }
        } catch {
          // A bad individual ini file should not hide other candidate roots.
        }
      }
    } catch {
      // Directory access can be denied while the profile-based paths still work.
    }
  }

  const profiles = new Set([env.USERPROFILE, homeDir].filter((value): value is string => Boolean(value)));
  for (const profile of profiles) {
    add("当前用户微信目录", path.join(profile, "xwechat_files"));
    add("当前用户 Documents", path.join(profile, "Documents", "xwechat_files"));
  }
  add("微信默认数据目录", path.join(appData, "Tencent", "xwechat"));
  return { roots, configFiles };
}

function inspectRoot(source: string, root: string): { check: WechatDbPathCheck; matches: string[]; fallback: string | null } {
  const check: WechatDbPathCheck = {
    source,
    rootExists: exists(root),
    xwechatFilesExists: false,
    accountDirectories: 0,
    dbStorageDirectories: 0,
    messageDirectories: 0,
    sampleDbDir: null,
    accessError: false,
  };
  const matches: string[] = [];
  let fallback: string | null = null;

  try {
    if (validDatabaseDirectory(root)) {
      check.xwechatFilesExists = true;
      check.accountDirectories = 1;
      check.dbStorageDirectories = 1;
      check.messageDirectories = 1;
      check.sampleDbDir = root;
      return { check, matches: [path.resolve(root)], fallback: null };
    }

    const nested = path.join(root, "xwechat_files");
    const filesRoot = exists(nested)
      ? nested
      : path.basename(root).toLowerCase() === "xwechat_files"
        ? root
        : null;
    if (!filesRoot || !isDirectory(filesRoot)) return { check, matches, fallback };

    check.xwechatFilesExists = true;
    for (const entry of fs.readdirSync(filesRoot)) {
      const accountDir = path.join(filesRoot, entry);
      if (!isDirectory(accountDir)) continue;
      check.accountDirectories++;

      const dbStorage = path.join(accountDir, "db_storage");
      if (!isDirectory(dbStorage)) continue;
      check.dbStorageDirectories++;
      check.sampleDbDir ??= dbStorage;
      fallback ??= dbStorage;

      const messageDir = path.join(dbStorage, "message");
      if (!isDirectory(messageDir)) continue;
      check.messageDirectories++;
      matches.push(path.resolve(dbStorage));
    }
  } catch {
    check.accessError = true;
  }
  return { check, matches, fallback };
}

/** Inspect the configured/current-user WeChat database locations without opening or changing them. */
export function diagnoseWechatDbDirectories(
  options: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): WechatDbDiscoveryDiagnostics {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const override = configuredDatabaseDirectory(env, homeDir);
  if (override) {
    return {
      configFiles: 0,
      detectedDbDir: override,
      checks: [{
        source: "显式配置的微信数据库目录",
        rootExists: true,
        xwechatFilesExists: true,
        accountDirectories: 1,
        dbStorageDirectories: 1,
        messageDirectories: 1,
        sampleDbDir: override,
        accessError: false,
      }],
    };
  }

  const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
  const { roots, configFiles } = configuredRoots(appData, homeDir, env);
  const checks: WechatDbPathCheck[] = [];
  let detectedDbDir: string | null = null;
  let newestMessageWrite = -1;
  let fallback: string | null = null;
  for (const candidate of roots) {
    const inspected = inspectRoot(candidate.source, candidate.root);
    checks.push(inspected.check);
    for (const match of inspected.matches) {
      let newest = 0;
      try { const dir = path.join(match, 'message');
        for (const file of fs.readdirSync(dir).filter(f => /^message_\d+\.db(?:-wal)?$/i.test(f)))
          newest = Math.max(newest, fs.statSync(path.join(dir, file)).mtimeMs);
      } catch {}
      if (newest > newestMessageWrite) { newestMessageWrite = newest; detectedDbDir = match; }
    }
    fallback ??= inspected.fallback;
  }

  return {
    configFiles,
    checks,
    detectedDbDir: detectedDbDir ?? fallback,
  };
}

export function autoDetectDbDir(): string | null {
  return diagnoseWechatDbDirectories().detectedDbDir;
}
