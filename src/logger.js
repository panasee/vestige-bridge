export function createLogger(apiLogger, { debug = false, prefix = '[vestige-bridge]' } = {}) {
  const logger = apiLogger ?? console;

  function log(method, fallbackMethod, args) {
    if (typeof logger[method] === 'function') {
      logger[method](prefix, ...args);
      return;
    }
    logger[fallbackMethod]?.(prefix, ...args);
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
      log('error', 'log', [message, detail]);
    },
  };
}
