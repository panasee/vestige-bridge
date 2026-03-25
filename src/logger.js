export function createLogger(apiLogger, { debug = false, prefix = '[vestige-bridge]' } = {}) {
  const logger = apiLogger ?? console;

  // OpenClaw RuntimeLogger expects (message: string, meta?: Record<string, unknown>).
  // Combine prefix + first string arg into message; remaining args become meta fields.
  function log(method, fallbackMethod, args) {
    const [first, ...rest] = args;
    const message = `${prefix} ${first ?? ''}`.trimEnd();
    const meta = rest.length > 0
      ? (rest.length === 1 && rest[0] !== null && typeof rest[0] === 'object' ? rest[0] : { detail: rest.join(' ') })
      : undefined;

    if (typeof logger[method] === 'function') {
      meta !== undefined ? logger[method](message, meta) : logger[method](message);
      return;
    }
    meta !== undefined ? logger[fallbackMethod]?.(message, meta) : logger[fallbackMethod]?.(message);
  }

  return {
    debug: (...args) => {
      if (!debug) {
        return;
      }
      log('debug', 'log', args);
    },
    info: (...args) => log('info', 'log', args),
    warn: (...args) => log('warn', 'log', args),
    error: (...args) => log('error', 'log', args),
    exception: (message, error) => {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      log('error', 'log', [message, { error: detail }]);
    },
  };
}
