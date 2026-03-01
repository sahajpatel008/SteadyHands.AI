import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { BrowserAction } from "../../shared/types";

export type StoredPath = {
  promptKey: string;
  promptNormalized: string;
  actions: BrowserAction[];
  createdAt: string;
};

type PathDbSchema = {
  bannedActions: string[];
  validPaths: StoredPath[];
  version: number;
};

const DB_VERSION = 1;
const DEFAULT_DB: PathDbSchema = {
  bannedActions: [],
  validPaths: [],
  version: DB_VERSION,
};

function getDbPath(): string {
  return path.join(app.getPath("userData"), "path-db.json");
}

function loadDb(): PathDbSchema {
  const dbPath = getDbPath();
  try {
    if (fs.existsSync(dbPath)) {
      const raw = fs.readFileSync(dbPath, "utf8");
      const parsed = JSON.parse(raw) as PathDbSchema;
      if (parsed.version === DB_VERSION) {
        return parsed;
      }
    }
  } catch {
    // fall through to default
  }
  return { ...DEFAULT_DB };
}

function saveDb(db: PathDbSchema): void {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");
}

export function addBannedActions(signatures: string[]): void {
  const db = loadDb();
  const set = new Set(db.bannedActions);
  for (const sig of signatures) {
    set.add(sig);
  }
  db.bannedActions = [...set];
  saveDb(db);
}

export function getBannedActions(): string[] {
  return loadDb().bannedActions;
}

export function addValidPath(pathEntry: StoredPath): void {
  const db = loadDb();
  db.validPaths.push(pathEntry);
  saveDb(db);
}

export function getAllPaths(): StoredPath[] {
  return loadDb().validPaths;
}

export async function findMatchingPath(
  prompt: string,
  semanticMatch: (stored: string, incoming: string) => Promise<boolean>,
): Promise<StoredPath | null> {
  const db = loadDb();
  const paths = [...db.validPaths].reverse();
  for (const p of paths) {
    if (Math.abs(p.promptNormalized.length - prompt.length) > 200) continue;
    if (await semanticMatch(p.promptNormalized, prompt)) {
      return p;
    }
  }
  return null;
}
