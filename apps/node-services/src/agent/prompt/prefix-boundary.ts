/**
 * Marks the end of the cacheable static system-prompt prefix. Static host
 * guides are inserted before this marker, and per-Agent / per-Room /
 * per-Task instructions follow it.
 */
export const STATIC_PREFIX_END_MARKER = "<!-- LINGER_STATIC_PREFIX_END -->";

export interface SplitInstructions {
  readonly static: string;
  readonly dynamic: string;
}
