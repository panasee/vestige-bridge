import fs from 'node:fs/promises';
import path from 'node:path';

function resolveStateHome() {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (typeof xdgStateHome === 'string' && xdgStateHome.trim().length > 0) {
    return xdgStateHome.trim();
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.local', 'state');
}

export function resolveCrystallizerMaterializedSourcesPath() {
  return path.join(resolveStateHome(), 'openclaw', 'memory-crystallizer', 'materialized-sources.json');
}

export async function loadCrystallizerMaterializedSources() {
  const ledgerPath = resolveCrystallizerMaterializedSourcesPath();
  try {
    const raw = await fs.readFile(ledgerPath, 'utf8');
    const parsed = JSON.parse(raw);
    const items = parsed && typeof parsed.items === 'object' && parsed.items ? parsed.items : {};
    return { path: ledgerPath, data: { version: 1, updatedAt: parsed?.updatedAt ?? null, items } };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { path: ledgerPath, data: { version: 1, updatedAt: null, items: {} } };
    }
    throw error;
  }
}

export function collectCrystallizedVestigeIds(data) {
  const items = data && typeof data.items === 'object' && data.items ? data.items : {};
  return Object.keys(items).filter((key) => typeof key === 'string' && key.trim().length > 0);
}
