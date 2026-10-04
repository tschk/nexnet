export class ConfigError extends Error {}

export interface GatewayConfig {
  audience: string;
  ownerIdentity: string | null;
  stateDir: string | null;
  rpId: string | null;
  origins: string[];
  now: () => number;
  publicRetentionMs: number;
  sessionMaxMs: number;
  wsAuthTimeoutMs?: number;
}

export const DEFAULT_PUBLIC_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_MAX_MS = 12 * 60 * 60 * 1000;

export function configFromEnv(env: Record<string, string | undefined>): GatewayConfig {
  const mode = env.NEXNET_MODE;
  if (mode === "chain") {
    throw new ConfigError(
      "NEXNET_MODE=chain needs NEXNET_CHAIN_ENDPOINT and NEXNET_CHAIN_CHECKPOINT and a chain client; no chain client exists yet"
    );
  }
  if (mode !== "dev-chain") {
    throw new ConfigError("Set NEXNET_MODE=dev-chain to run against the in-memory development chain");
  }
  const audience = env.NEXNET_AUDIENCE ?? env.NEXNET_PUBLIC_URL;
  if (!audience) {
    throw new ConfigError("Set NEXNET_AUDIENCE or NEXNET_PUBLIC_URL");
  }
  const ownerIdentity = env.NEXNET_OWNER_IDENTITY ?? null;
  if (ownerIdentity !== null && !/^[0-9a-f]{64}$/.test(ownerIdentity)) {
    throw new ConfigError("NEXNET_OWNER_IDENTITY must be 64 lowercase hex characters");
  }
  const origins = (env.NEXNET_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigError(`NEXNET_ORIGINS contains an invalid origin: ${origin}`);
    }
    if (parsed.origin !== origin) {
      throw new ConfigError(`NEXNET_ORIGINS entries must be bare origins: ${origin}`);
    }
  }
  return {
    audience,
    ownerIdentity,
    stateDir: env.NEXNET_STATE_DIR ?? null,
    rpId: env.NEXNET_RP_ID ?? null,
    origins,
    now: Date.now,
    publicRetentionMs: DEFAULT_PUBLIC_RETENTION_MS,
    sessionMaxMs: DEFAULT_SESSION_MAX_MS,
  };
}
