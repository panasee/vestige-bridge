import { resolvePluginConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { materializeExportEnvelope } from '../src/materialization.js';
import { VestigeSidecarClient } from '../src/sidecar-client.js';

const workspaceDir = process.env.WORKSPACE_DIR ?? '/home/dongkai-claw/.openclaw/workspace';
const config = resolvePluginConfig({
  baseUrl: process.env.VESTIGE_SIDECAR_URL,
  timeoutMs: Number(process.env.VESTIGE_TIMEOUT_MS || 5000),
  export: {
    rootDir: process.env.VESTIGE_EXPORT_ROOT,
  },
  debug: process.env.VESTIGE_DEBUG === '1',
}, workspaceDir);

const logger = createLogger(console, { debug: config.debug });
const sidecarClient = new VestigeSidecarClient({
  baseUrl: config.baseUrl,
  timeoutMs: config.timeoutMs,
  logger,
});

const sessionKey = process.env.SESSION_KEY;
await sidecarClient.consolidate({ session_key: sessionKey, reason: 'explicit_export_script' });
const exportResult = await sidecarClient.exportStable({ session_key: sessionKey, reason: 'explicit_export_script' });
if (!exportResult.ok) {
  throw new Error(exportResult.error || 'exportStable failed');
}
const result = await materializeExportEnvelope(exportResult.data, config.export, { sidecarClient });
console.log(JSON.stringify(result, null, 2));
