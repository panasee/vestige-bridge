import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createVestigeBridgeRuntime } from '../../src/index.js';

async function loadPluginConfig() {
  try {
    const configPath =
      process.env.OPENCLAW_CONFIG_PATH ||
      path.join(homedir(), '.openclaw', 'openclaw.json');
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    return raw?.plugins?.entries?.['vestige-bridge']?.config ?? {};
  } catch {
    return {};
  }
}

let runtimePromise = null;

async function getRuntime(event) {
  if (!runtimePromise) {
    runtimePromise = loadPluginConfig().then((pluginConfig) =>
      createVestigeBridgeRuntime({
        pluginConfig,
        workspaceDir: event?.context?.workspaceDir || process.cwd(),
      }),
    );
  }
  return runtimePromise;
}

export default async function vestigeTriggerHook(event) {
  const runtime = await getRuntime(event);

  if (event?.type === 'gateway' && event?.action === 'startup') {
    await runtime.sessionEnd({ type: 'time', action: 'time', timestamp: new Date().toISOString() }, event?.context || {});
    runtime.scheduleNextTimeTrigger(event?.context || {});
    return;
  }

  if (event?.type === 'command' && event?.action === 'new') {
    await runtime.commandNew(event, event?.context || {});
    return;
  }

  if (event?.type === 'command' && event?.action === 'reset') {
    await runtime.commandReset(event, event?.context || {});
    return;
  }

  if (event?.type === 'session' && event?.action === 'compact:after') {
    await runtime.commandCompact(event, event?.context || {});
    return;
  }

  if (event?.type === 'session' && event?.action === 'end') {
    await runtime.sessionEnd(event, event?.context || {});
  }
}
