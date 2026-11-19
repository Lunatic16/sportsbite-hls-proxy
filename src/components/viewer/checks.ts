/**
 * Concurrent channel status checking with live progress.
 * Fans out per-channel POST /api/channels/:id/check calls with bounded
 * parallelism and streams results back so dots update in real time.
 */
import { checkChannel } from '@/lib/api';
import type { CheckResult } from '@/lib/types';

export async function runChecks(
  ids: string[],
  concurrency: number,
  onUpdate: (result: CheckResult) => void,
  shouldStop?: () => boolean,
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < ids.length) {
      if (shouldStop?.()) return;
      const id = ids[index++]!;
      try {
        onUpdate(await checkChannel(id));
      } catch {
        /* per-channel failures are surfaced via the status dot itself */
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, () => worker()),
  );
}
