import fs from 'node:fs/promises';
import path from 'node:path';

const LEDGER_VERSION = 1;
const DEFAULT_LEDGER_FILENAME = '.materialization-ledger.json';

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
    source_export_path: typeof record.source_export_path === 'string' ? record.source_export_path : null,
    category: typeof record.category === 'string' ? record.category : null,
    statement: typeof record.statement === 'string' ? record.statement : null,
    confidence: typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? record.confidence : null,
  };
}

export function resolveLedgerPath(exportConfig = {}) {
  const rootDir = typeof exportConfig.rootDir === 'string' && exportConfig.rootDir.trim().length > 0
    ? exportConfig.rootDir
    : process.cwd();
  const configured = typeof exportConfig.ledgerPath === 'string' && exportConfig.ledgerPath.trim().length > 0
    ? exportConfig.ledgerPath.trim()
    : DEFAULT_LEDGER_FILENAME;

  return path.isAbsolute(configured)
    ? configured
    : path.join(rootDir, configured);
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
    : DEFAULT_LEDGER_FILENAME;
  const directory = path.dirname(targetPath);
  const payload = {
    version: LEDGER_VERSION,
    updated_at: typeof data?.updated_at === 'string' ? data.updated_at : new Date().toISOString(),
    items: ensureRecord(data?.items),
  };

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

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
  exportPath = null,
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
  const envelopeItems = new Map(
    Array.isArray(envelope?.items)
      ? envelope.items.map((item) => [item.vestige_id, item])
      : [],
  );

  for (const item of payloadItems) {
    if (!item || typeof item !== 'object' || typeof item.vestige_id !== 'string' || !item.vestige_id) {
      continue;
    }

    const source = envelopeItems.get(item.vestige_id) || {};
    ledger.items[item.vestige_id] = normalizeLedgerEntry(item.vestige_id, {
      shard_key: item.shard_key,
      generation_id: materialized?.generation_id,
      generated_at: materialized?.generated_at,
      materialized_at: now,
      source_export_path: exportPath,
      category: source.category,
      statement: source.statement,
      confidence: source.confidence,
    });
  }

  ledger.updated_at = now;
  return ledger;
}
