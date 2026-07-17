export type PasskeyRegistrationRequest = {
  rpId: string;
  challenge: string;
  userId: string;
  userName: string;
  displayName?: string;
};

export type PasskeyRegistrationResponse = {
  credentialId: string;
  attestationObject: string;
  clientDataJSON: string;
};

export type PasskeyAssertionRequest = {
  rpId: string;
  challenge: string;
  credentialId?: string;
};

export type PasskeyAssertionResponse = {
  credentialId: string;
  authenticatorData: string;
  signature: string;
  clientDataJSON: string;
  userId?: string;
};

type BridgeInput =
  | ({ operation: "register" } & PasskeyRegistrationRequest)
  | ({ operation: "assert" } & PasskeyAssertionRequest);

const base64url = /^[A-Za-z0-9_-]+$/;

function bridgePath(): string {
  if (process.platform !== "darwin") throw new Error("Native passkeys require macOS");
  return process.env.NEXNET_PASSKEY_BRIDGE ?? new URL("../native/nexnet-passkey", import.meta.url).pathname;
}

function requireBase64url(value: unknown, field: string): string {
  if (typeof value !== "string" || !base64url.test(value)) throw new Error(`Invalid passkey bridge ${field}`);
  return value;
}

export function parsePasskeyBridgeResponse(value: string, operation: BridgeInput["operation"]): PasskeyRegistrationResponse | PasskeyAssertionResponse {
  let output: Record<string, unknown>;
  try {
    output = JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid passkey bridge response");
  }
  const credentialId = requireBase64url(output.credentialId, "credentialId");
  const clientDataJSON = requireBase64url(output.clientDataJSON, "clientDataJSON");
  if (operation === "register") {
    return { credentialId, clientDataJSON, attestationObject: requireBase64url(output.attestationObject, "attestationObject") };
  }
  const userId = output.userId === undefined ? undefined : requireBase64url(output.userId, "userId");
  return {
    credentialId,
    clientDataJSON,
    authenticatorData: requireBase64url(output.authenticatorData, "authenticatorData"),
    signature: requireBase64url(output.signature, "signature"),
    ...(userId ? { userId } : {}),
  };
}

async function invoke(input: BridgeInput): Promise<PasskeyRegistrationResponse | PasskeyAssertionResponse> {
  const process = Bun.spawn([bridgePath()], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (status !== 0) throw new Error(stderr.trim() || "Passkey authorization failed");
  return parsePasskeyBridgeResponse(stdout, input.operation);
}

export async function registerNativePasskey(input: PasskeyRegistrationRequest): Promise<PasskeyRegistrationResponse> {
  return invoke({ operation: "register", ...input }) as Promise<PasskeyRegistrationResponse>;
}

export async function assertNativePasskey(input: PasskeyAssertionRequest): Promise<PasskeyAssertionResponse> {
  return invoke({ operation: "assert", ...input }) as Promise<PasskeyAssertionResponse>;
}
