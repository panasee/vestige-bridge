import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LEDGER_VERSION = 1;
const DEFAULT_STATE_SUBDIR = path.join('openclaw', 'vestige-bridge', 'ledgers');

function ensureRecord(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeLedgerEntry(id, entry = {}) {
  const record = ensureRecord(entry);
  return {
    vestige_id: id,
    shard_key: typeof record.shard_key === 'string' ? record.shard_key : null,
    generation_id: typeof record.generation_id === 'string' ? record.generation_id : null,
    generated_at: typeof record.generated_at === 'string' ? record.generated_at : null,
    materialized_at: typeof record.materialized_at === 'string' ? record.materialized_at : null,
  };
}

function resolveStateRoot() {
  const xdgStateHome = typeof process.env.XDG_STATE_HOME === 'string' && process.env.XDG_STATE_HOME.trim().length > 0
    ? process.env.XDG_STATE_HOME.trim()
    : null;
  return xdgStateHome || path.join(os.homedir(), '.local', 'state');
}

function resolveDefaultLedgerDir() {
  return path.join(resolveStateRoot(), DEFAULT_STATE_SUBDIR);
}

function buildLedgerName(rootDir) {
  const normalizedRoot = path.resolve(String(rootDir || process.cwd()));
  const digest = createHash('sha256').update(normalizedRoot).digest('hex').slice(0, 20);
  return `${digest}.json`;
}

export function resolveLedgerPath(exportConfig = {}) {
  const rootDir = typeof exportConfig.rootDir === 'string' && exportConfig.rootDir.trim().length > 0
    ? exportConfig.rootDir
    : process.cwd();
  const defaultDir = resolveDefaultLedgerDir();
  const configured = typeof exportConfig.ledgerPath === 'string' && exportConfig.ledgerPath.trim().length > 0
    ? exportConfig.ledgerPath.trim()
    : null;

  if (!configured) {
    return path.join(defaultDir, buildLedgerName(rootDir));
  }

  return path.isAbsolute(configured)
    ? configured
    : path.join(defaultDir, configured);
}

export function createEmptyLedger() {
  return {
    version: LEDGER_VERSION,
    updated_at: null,
    items: {},
  };
}

export async function loadMaterializationLedger(exportConfig = {}) {
  const ledgerPath = resolveLedgerPath(exportConfig);

  try {
    const text = await fs.readFile(ledgerPath, 'utf8');
    const parsed = JSON.parse(text);
    const items = ensureRecord(parsed.items);

    return {
      path: ledgerPath,
      data: {
        version: LEDGER_VERSION,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
        items: Object.fromEntries(
          Object.entries(items).map(([id, entry]) => [id, normalizeLedgerEntry(id, entry)]),
        ),
      },
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { path: ledgerPath, data: createEmptyLedger() };
    }
    throw error;
  }
}

export async function saveMaterializationLedger(ledgerPath, data) {
  const targetPath = typeof ledgerPath === 'string' && ledgerPath.trim().length > 0
    ? ledgerPath
    : path.join(resolveDefaultLedgerDir(), buildLedgerName(process.cwd()));
  const directory = path.dirname(targetPath);
  const payload = {
    version: LEDGER_VERSION,
    updated_at: typeof data?.updated_at === 'string' ? data.updated_at : new Date().toISOString(),
    items: ensureRecord(data?.items),
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

  return {
    path: targetPath,
    data: payload,
  };
}

export function collectMaterializedIds(ledgerData) {
  const items = ensureRecord(ledgerData?.items);
  return new Set(Object.keys(items).filter(Boolean));
}

export function updateMaterializationLedger({
  ledgerData,
  materialized,
  envelope,
  now = new Date().toISOString(),
}) {
  const ledger = createEmptyLedger();
  const existing = ensureRecord(ledgerData?.items);
  ledger.items = Object.fromEntries(
    Object.entries(existing).map(([id, entry]) => [id, normalizeLedgerEntry(id, entry)]),
  );

  const payloadItems = Array.isArray(materialized?.callback_payload?.items)
    ? materialized.callback_payload.items
    : [];
  for (const item of payloadItems) {
    if (!item || typeof item !== 'object' || typeof item.vestige_id !== 'string' || !item.vestige_id) {
      continue;
    }

    ledger.items[item.vestige_id] = normalizeLedgerEntry(item.vestige_id, {
      shard_key: item.shard_key,
      generation_id: materialized?.generation_id,
      generated_at: materialized?.generated_at,
      materialized_at: now,
    });
  }

  ledger.updated_at = now;
  return ledger;
}
