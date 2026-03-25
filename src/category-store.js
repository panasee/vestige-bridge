/**
 * src/category-store.js
 * External ID→category mapping store.
 *
 * Vestige stores only clean content text; category metadata lives here as
 * a separate JSON file keyed by vestige node ID.
 *
 * Path: $XDG_STATE_HOME/openclaw/vestige-bridge/categories.json
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_STATE_SUBDIR = path.join('openclaw', 'vestige-bridge');
const STORE_FILENAME = 'categories.json';

function resolveStateRoot() {
  const xdgStateHome =
    typeof process.env.XDG_STATE_HOME === 'string' && process.env.XDG_STATE_HOME.trim().length > 0
      ? process.env.XDG_STATE_HOME.trim()
      : null;
  return xdgStateHome || path.join(os.homedir(), '.local', 'state');
}

export function resolveCategoryStorePath() {
  return path.join(resolveStateRoot(), DEFAULT_STATE_SUBDIR, STORE_FILENAME);
}

export function createEmptyStore() {
  return {
    version: STORE_VERSION,
    updated_at: null,
    items: {},
  };
}

export async function loadCategoryStore() {
  const storePath = resolveCategoryStorePath();

  try {
    const text = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(text);
    const raw = parsed.items && typeof parsed.items === 'object' && !Array.isArray(parsed.items)
      ? parsed.items
      : {};

    return {
      path: storePath,
      data: {
        version: STORE_VERSION,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
        items: Object.fromEntries(
          Object.entries(raw).filter(
            ([id, cat]) => typeof id === 'string' && id && typeof cat === 'string' && cat,
          ),
        ),
      },
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { path: storePath, data: createEmptyStore() };
    }
    throw error;
  }
}

export async function saveCategoryStore(storePath, data) {
  const targetPath =
    typeof storePath === 'string' && storePath.trim().length > 0
      ? storePath
      : resolveCategoryStorePath();
  const directory = path.dirname(targetPath);
  const payload = {
    version: STORE_VERSION,
    updated_at:
      typeof data?.updated_at === 'string' ? data.updated_at : new Date().toISOString(),
    items:
      data?.items && typeof data.items === 'object' && !Array.isArray(data.items)
        ? data.items
        : {},
  };

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);

  const handle = await fs.open(targetPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  await fs.chmod(targetPath, 0o600).catch(() => undefined);

  return { path: targetPath, data: payload };
}

/**
 * Atomically merge new {nodeId → category} entries into the persistent store.
 */
export async function mergeCategoryEntries(newEntries) {
  if (!newEntries || typeof newEntries !== 'object' || Object.keys(newEntries).length === 0) {
    return;
  }

  const loaded = await loadCategoryStore();
  const merged = {
    ...loaded.data,
    items: { ...loaded.data.items, ...newEntries },
    updated_at: new Date().toISOString(),
  };

  await saveCategoryStore(loaded.path, merged);
}

/**
 * Look up stored categories for an array of vestige node IDs.
 * Returns a Map<nodeId, category> containing only IDs that have a mapping.
 */
export async function lookupCategories(nodeIds) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    return new Map();
  }

  const loaded = await loadCategoryStore();
  const result = new Map();
  for (const id of nodeIds) {
    if (typeof id === 'string' && id && loaded.data.items[id]) {
      result.set(id, loaded.data.items[id]);
    }
  }
  return result;
}
