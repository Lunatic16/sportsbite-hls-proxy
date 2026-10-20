import type { Channel, ResolvedStream } from '../channels/types.js';

export interface Resolver {
  readonly name: string;
  resolve(channel: Channel): Promise<ResolvedStream>;
}
