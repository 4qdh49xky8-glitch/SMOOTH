import { defaultUserDataDir } from "../browser/launch.js";
import type { BotConfig } from "../config/schema.js";
import type { SiteAdapter } from "../sites/SiteAdapter.js";
import { eventKey, profileKey } from "../utils/lock.js";

export interface LockKey {
  key: string;
  what: "événement" | "profil de navigateur";
}

/**
 * Les verrous que `run` prend pour un canal donné : toujours celui de l'événement ; celui du profil de navigateur pour le canal navigateur.
 * Source UNIQUE : `run`, `sale:check` (lecture) et `sale:wait` (conservation pendant l'attente) utilisent exactement les mêmes clés.
 */
export function lockKeysFor(adapter: SiteAdapter, cfg: BotConfig, channel: "official-api" | "browser" | "human", profile: string): LockKey[] {
  const keys: LockKey[] = [{ key: eventKey(adapter.meta.id, adapter.resolveEventUrl(cfg)), what: "événement" }];
  if (channel === "browser") keys.push({ key: profileKey(cfg.browser.userDataDir ?? defaultUserDataDir(profile)), what: "profil de navigateur" });
  return keys;
}
