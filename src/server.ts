/**
 * Fastify bootstrap: routes, logging (redacted), graceful shutdown,
 * unhandled-rejection handling.
 */
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { loadConfig } from './config.js';
import { getLogger } from './util/logger.js';
import { store } from './channels/store.js';
import { registerApiRoutes } from './routes/api.js';
import { registerPlaylistRoutes } from './routes/playlist.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerShareRoutes } from './routes/share.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { destroyAgent } from './net/fetchUpstream.js';
import { redactUrl } from './util/logger.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = getLogger();
  store.ensureLoaded();

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: cfg.trustProxy,
    disableRequestLogging: false,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
  });

  // Never log signed proxy URLs at info level; segments/keys are noisy → debug.
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/proxy/segment') || req.url.startsWith('/proxy/key')) {
      (req as unknown as { log: { level: string } }).log.level = 'silent';
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/proxy/segment') || req.url.startsWith('/proxy/key')) return;
    const ms = Math.round(reply.elapsedTime);
    req.log.info({ method: req.method, url: redactUrl(req.raw.url), status: reply.statusCode, ms }, 'request');
  });

  registerProxyRoutes(app);
  registerStreamRoutes(app);
  registerPlaylistRoutes(app);
  registerShareRoutes(app);
  registerApiRoutes(app);

  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .header('access-control-allow-origin', '*')
      .send({ error: `no route: ${redactUrl(req.raw.url)}` });
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err: (err as Error).message, url: redactUrl(req.raw.url) }, 'unhandled route error');
    void reply
      .code(500)
      .header('access-control-allow-origin', '*')
      .send({ error: 'internal error' });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await destroyAgent();
      store.stopWatching();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception — exiting');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason: String(reason) }, 'unhandled rejection — exiting');
    process.exit(1);
  });

  await app.listen({ port: cfg.port, host: cfg.host });
  logger.info({ port: cfg.port, host: cfg.host, channels: store.list().length }, 'sportsbite-hls-proxy listening');
}

main().catch((err) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
