import type { StripRef } from '@shared/domain/ids';

/** "Ch 12": the channel's number, as on the iLive surface. */
export const sourceLabel = (ref: StripRef): string => `Ch ${ref.index + 1}`;
