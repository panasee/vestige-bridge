const REGISTRY_KEY = Symbol.for('openclaw.recallProviders');

function getRegistryMap() {
  if (!globalThis[REGISTRY_KEY]) {
    globalThis[REGISTRY_KEY] = new Map();
  }
  return globalThis[REGISTRY_KEY];
}

export function registerSharedRecallProvider(provider) {
  if (!provider || typeof provider.recall !== 'function' || !provider.id) {
    return false;
  }
  getRegistryMap().set(provider.id, provider);
  return true;
}
