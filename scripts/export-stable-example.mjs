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
  failSoft: false,
});

const sessionKey = process.env.SESSION_KEY;
await sidecarClient.consolidate({ session_key: sessionKey, reason: 'explicit_export_script' });
const envelope = await sidecarClient.exportStable({ session_key: sessionKey, reason: 'explicit_export_script' });
const result = await materializeExportEnvelope(envelope, config.export, { logger, sidecarClient });
console.log(JSON.stringify(result, null, 2));
