import { AgentError, codeForStatus } from "./errors.js";

export class GatewayApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  get url(): string {
    return this.baseUrl;
  }

  async request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AgentError("offline", "Cannot reach the gateway");
    }
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw new AgentError(
        codeForStatus(response.status, parsed?.error?.code),
        typeof parsed?.error?.message === "string" ? parsed.error.message : `Gateway returned ${response.status}`
      );
    }
    return parsed as T;
  }

  streamUrl(): string {
    return `${this.baseUrl.replace(/^http/, "ws")}/v1/stream`;
  }
}
