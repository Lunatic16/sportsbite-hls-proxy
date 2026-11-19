/**
 * Next.js instrumentation entry. Runs once per server start.
 * Process-level hooks live in process-hooks.ts and are only loaded in the
 * Node.js runtime (they are meaningless — and flagged — under Edge).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./process-hooks');
    // Startup auto-import of the channel list (sportsbite catalog by default).
    // Scheduled in the background — never blocks the server from listening.
    const { scheduleChannelBootstrap } = await import('./server/channels/bootstrap');
    scheduleChannelBootstrap();
  }
}
