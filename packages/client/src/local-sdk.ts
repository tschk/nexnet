import type { LocalInboxMessage, LocalMessageState, LocalPresence, LocalStatus } from "./local-api.js";
export type { LocalInboxMessage, LocalMessageState, LocalPresence, LocalStatus } from "./local-api.js";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const invalid = () => new Error("Invalid local daemon response");

export class LocalApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Local daemon: ${code}`);
  }
}

/** Fetch-only SDK: no device keys, unlock key, storage or root signer in the caller. */
export class LocalNexnet {
  private readonly url: string;
  constructor(
    url: string,
    private readonly token: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      !parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("Local daemon URL must be an explicit http://127.0.0.1:PORT origin");
    }
    if (!id(token)) throw new Error("Invalid local control token");
    this.url = parsed.origin;
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const result: unknown = await response.json();
    if (!object(result) || result.version !== 1) throw invalid();
    if (!response.ok) {
      if (!object(result.error) || typeof result.error.code !== "string") throw invalid();
      throw new LocalApiError(result.error.code, response.status);
    }
    return result.data;
  }

  async status(): Promise<LocalStatus> {
    const result = await this.request("/v1/status");
    if (
      !object(result) ||
      !id(result.identityId) ||
      !id(result.deviceId) ||
      typeof result.online !== "boolean" ||
      typeof result.transportError !== "boolean" ||
      typeof result.certificateExpiresAt !== "number" ||
      !Number.isSafeInteger(result.certificateExpiresAt)
    )
      throw invalid();
    return {
      identityId: result.identityId,
      deviceId: result.deviceId,
      online: result.online,
      certificateExpiresAt: result.certificateExpiresAt,
      transportError: result.transportError,
    };
  }

  private messageState(result: unknown): LocalMessageState {
    if (!object(result) || !id(result.messageId) || (result.state !== "queued" && result.state !== "delivered"))
      throw invalid();
    return { messageId: result.messageId, state: result.state };
  }

  async send(peer: string, text: string): Promise<LocalMessageState> {
    if (!id(peer)) throw new Error("Invalid peer identity");
    return this.messageState(await this.request("/v1/messages", { peer, text }));
  }

  async delivery(messageId: string): Promise<LocalMessageState> {
    if (!id(messageId)) throw new Error("Invalid message id");
    const result = this.messageState(await this.request(`/v1/messages/${messageId}`));
    if (result.messageId !== messageId) throw invalid();
    return result;
  }

  async inbox(): Promise<LocalInboxMessage[]> {
    const result = await this.request("/v1/inbox");
    if (!Array.isArray(result)) throw invalid();
    return result.map((entry: unknown) => {
      if (
        !object(entry) ||
        !id(entry.messageId) ||
        !id(entry.peer) ||
        typeof entry.text !== "string" ||
        typeof entry.createdAt !== "number" ||
        !Number.isSafeInteger(entry.createdAt)
      )
        throw invalid();
      return { messageId: entry.messageId, peer: entry.peer, text: entry.text, createdAt: entry.createdAt };
    });
  }

  async presence(peer: string): Promise<LocalPresence> {
    if (!id(peer)) throw new Error("Invalid peer identity");
    const result = await this.request(`/v1/presence/${peer}`);
    if (!object(result) || result.peer !== peer || (result.online !== null && typeof result.online !== "boolean"))
      throw invalid();
    return { peer, online: result.online };
  }
}
