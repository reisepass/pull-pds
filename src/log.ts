import winston from 'winston';

/**
 * Shared structured logger. Level defaults to `info`; override with LOG_LEVEL.
 * Everything on the write path logs through here so failures stay observable
 * without ever throwing into a caller's request path.
 */
export const log = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
});
