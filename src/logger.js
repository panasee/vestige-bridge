export function createLogger(apiLogger, { debug = false } = {}) {
  const logger = apiLogger ?? console;

  return {
    debug: (...args) => {
      if (!debug) {
        return;
      }
      if (typeof logger.debug === 'function') {
        logger.debug('[vestige-bridge]', ...args);
        return;
      }
      logger.log?.('[vestige-bridge][debug]', ...args);
    },
    info: (...args) => {
      logger.info?.('[vestige-bridge]', ...args);
    },
    warn: (...args) => {
      logger.warn?.('[vestige-bridge]', ...args);
    },
    error: (...args) => {
      logger.error?.('[vestige-bridge]', ...args);
    },
  };
}
