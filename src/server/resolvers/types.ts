import type { Channel, ResolvedStream } from '../channels/types';

export interface Resolver {
  readonly name: string;
  resolve(channel: Channel): Promise<ResolvedStream>;
}
