export type ErrorCode =
  | "unconfigured"
  | "offline"
  | "unauthenticated"
  | "forbidden"
  | "revoked"
  | "rate_limited"
  | "invalid"
  | "internal";

export class AgentError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function codeForStatus(status: number, gatewayCode: string | undefined): ErrorCode {
  if (gatewayCode === "revoked") return "revoked";
  if (gatewayCode === "rate_limited" || status === 429) return "rate_limited";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 400 || status === 404 || status === 409 || status === 413) return "invalid";
  if (status === 503) return "offline";
  return "internal";
}
