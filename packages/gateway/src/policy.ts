export type ChannelId = "updates" | "public";

export interface ChannelPolicy {
  id: ChannelId;
  writers: "owner" | "registered";
  rateLimit: number;
  retains: boolean;
}

export const CHANNELS: Record<ChannelId, ChannelPolicy> = {
  updates: { id: "updates", writers: "owner", rateLimit: 30, retains: true },
  public: { id: "public", writers: "registered", rateLimit: 5, retains: false },
};

export const MAX_BODY_BYTES = 2000;
export const RATE_WINDOW_MS = 60_000;
export const SPAM_DUPLICATE_THRESHOLD = 3;

export function isChannelId(value: string): value is ChannelId {
  return value === "updates" || value === "public";
}

const BIDI_CONTROLS = /\p{Bidi_Control}/u;
const INVISIBLE_FORMAT = /(?!\p{Join_Control})\p{Cf}/u;
const COMBINING_RUN = /\p{M}{9,}/u;
const CONTROL_OR_SURROGATE = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;

export function validateBody(body: string): string | null {
  if (body.trim().length === 0) return "Message is empty";
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return `Message exceeds ${MAX_BODY_BYTES} bytes`;
  if (CONTROL_OR_SURROGATE.test(body)) return "Message contains control characters";
  if (BIDI_CONTROLS.test(body)) return "Message contains bidirectional control characters";
  if (INVISIBLE_FORMAT.test(body)) return "Message contains invisible formatting characters";
  if (COMBINING_RUN.test(body)) return "Message contains too many combining marks";
  return null;
}

export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) {
      for (const [entry, times] of this.hits) {
        if (times.every((at) => now - at >= this.windowMs)) this.hits.delete(entry);
      }
    }
    return true;
  }
}

export class DuplicateGuard {
  private readonly texts = new Map<string, { at: number; body: string }[]>();

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, body: string, now: number): boolean {
    const recent = (this.texts.get(key) ?? []).filter((entry) => now - entry.at < this.windowMs);
    const duplicates = recent.filter((entry) => entry.body === body).length;
    if (duplicates + 1 >= this.threshold) {
      this.texts.set(key, recent);
      return false;
    }
    recent.push({ at: now, body });
    this.texts.set(key, recent);
    return true;
  }
}
