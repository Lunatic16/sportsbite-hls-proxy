/**
 * Process-level resilience for the Next.js server.
 *
 * The old app exited on ANY unhandled rejection — one stream race killed the
 * container and Docker restarted it ("docker container fails often"). The
 * policy here: log and keep serving. A repeated crash pattern (5 uncaught
 * exceptions in 60s) still exits so a supervisor can replace a truly broken
 * process.
 */

let uncaughtCount = 0;
let windowStart = Date.now();

process.on('unhandledRejection', (reason) => {
  console.error(
    JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      msg: 'unhandled rejection (server keeps running)',
      reason: reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason),
    }),
  );
});

process.on('uncaughtException', (err) => {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    uncaughtCount = 0;
  }
  uncaughtCount++;
  console.error(
    JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      msg: 'uncaught exception (server keeps running)',
      err: `${err.message}\n${err.stack}`,
      count: uncaughtCount,
    }),
  );
  if (uncaughtCount >= 5) {
    console.error(
      JSON.stringify({ level: 'fatal', time: new Date().toISOString(), msg: 'repeated uncaught exceptions — exiting' }),
    );
    process.exit(1);
  }
});

const shutdown = (signal: string) => {
  console.log(
    JSON.stringify({ level: 'info', time: new Date().toISOString(), msg: 'shutting down', signal }),
  );
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Side-effect-only module — the empty export makes it a proper ES module.
export {};
