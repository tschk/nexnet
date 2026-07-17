/**
 * @nexnet/client — MLS groups via ts-mls (RFC 9420)
 *
 * Ciphersuite: MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519
 * Real ratchet tree / welcome / private messages — not a simplified stand-in.
 */

import {
  createApplicationMessage,
  createCommit,
  createGroup,
  createProposal,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  decodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  processPrivateMessage,
  zeroOutUint8Array,
  type ClientState,
  type CiphersuiteImpl,
  type Credential,
  type KeyPackage,
  type PrivateKeyPackage,
  type Proposal,
  type Welcome,
  type PrivateMessage,
  type MLSMessage,
} from "ts-mls";

const SUITE_NAME = "MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519" as const;

let suitePromise: Promise<CiphersuiteImpl> | null = null;

export async function mlsCiphersuite(): Promise<CiphersuiteImpl> {
  if (!suitePromise) {
    suitePromise = getCiphersuiteImpl(getCiphersuiteFromName(SUITE_NAME));
  }
  return suitePromise;
}

export interface MlsMemberKeys {
  identity: Uint8Array;
  publicPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
}

export async function generateMlsMember(
  identityBytes: Uint8Array
): Promise<MlsMemberKeys> {
  const impl = await mlsCiphersuite();
  const credential: Credential = {
    credentialType: "basic",
    identity: identityBytes,
  };
  const kp = await generateKeyPackage(
    credential,
    defaultCapabilities(),
    defaultLifetime,
    [],
    impl
  );
  return {
    identity: identityBytes,
    publicPackage: kp.publicPackage,
    privatePackage: kp.privatePackage,
  };
}

export async function mlsCreateGroup(
  groupId: Uint8Array,
  creator: MlsMemberKeys
): Promise<ClientState> {
  const impl = await mlsCiphersuite();
  return createGroup(
    groupId,
    creator.publicPackage,
    creator.privatePackage,
    [],
    impl
  );
}

/**
 * Creator adds member via Add proposal + Commit; returns welcome for joiner.
 */
export async function mlsAddMember(
  state: ClientState,
  memberKeyPackage: KeyPackage
): Promise<{ state: ClientState; welcome: Welcome; commit: MLSMessage }> {
  const impl = await mlsCiphersuite();
  const add: Proposal = {
    proposalType: "add",
    add: { keyPackage: memberKeyPackage },
  };
  const result = await createCommit(
    { state, cipherSuite: impl },
    { extraProposals: [add], ratchetTreeExtension: true }
  );
  result.consumed.forEach(zeroOutUint8Array);
  if (!result.welcome) {
    throw new Error("mls: commit missing welcome");
  }
  return {
    state: result.newState,
    welcome: result.welcome,
    commit: result.commit,
  };
}

/**
 * Creator removes member by leaf index.
 */
export async function mlsRemoveMember(
  state: ClientState,
  removedLeafIndex: number
): Promise<{ state: ClientState; commit: MLSMessage }> {
  const impl = await mlsCiphersuite();
  const remove: Proposal = {
    proposalType: "remove",
    remove: { removed: removedLeafIndex as never },
  };
  const result = await createCommit(
    { state, cipherSuite: impl },
    { extraProposals: [remove] }
  );
  result.consumed.forEach(zeroOutUint8Array);
  return { state: result.newState, commit: result.commit };
}

export async function mlsJoin(
  welcome: Welcome,
  member: MlsMemberKeys,
  ratchetTree?: ClientState["ratchetTree"]
): Promise<ClientState> {
  const impl = await mlsCiphersuite();
  return joinGroup(
    welcome,
    member.publicPackage,
    member.privatePackage,
    emptyPskIndex,
    impl,
    ratchetTree
  );
}

export async function mlsEncrypt(
  state: ClientState,
  plaintext: Uint8Array
): Promise<{ state: ClientState; privateMessage: PrivateMessage; wire: Uint8Array }> {
  const impl = await mlsCiphersuite();
  const result = await createApplicationMessage(state, plaintext, impl);
  result.consumed.forEach(zeroOutUint8Array);
  const wire = encodeMlsMessage({
    privateMessage: result.privateMessage,
    wireformat: "mls_private_message",
    version: "mls10",
  });
  return {
    state: result.newState,
    privateMessage: result.privateMessage,
    wire,
  };
}

export async function mlsDecrypt(
  state: ClientState,
  wire: Uint8Array
): Promise<{ state: ClientState; plaintext: Uint8Array }> {
  const impl = await mlsCiphersuite();
  const decoded = decodeMlsMessage(wire, 0)?.[0];
  if (!decoded || decoded.wireformat !== "mls_private_message") {
    throw new Error("mls: expected private message");
  }
  const result = await processPrivateMessage(
    state,
    decoded.privateMessage,
    emptyPskIndex,
    impl
  );
  result.consumed.forEach(zeroOutUint8Array);
  if (result.kind !== "applicationMessage") {
    throw new Error("mls: expected application message");
  }
  return { state: result.newState, plaintext: result.message };
}

/** Encode key package for transport. */
export function encodeKeyPackage(kp: KeyPackage): Uint8Array {
  return encodeMlsMessage({
    keyPackage: kp,
    wireformat: "mls_key_package",
    version: "mls10",
  });
}

export function decodeKeyPackage(wire: Uint8Array): KeyPackage {
  const decoded = decodeMlsMessage(wire, 0)?.[0];
  if (!decoded || decoded.wireformat !== "mls_key_package") {
    throw new Error("mls: expected key package");
  }
  return decoded.keyPackage;
}

export function encodeWelcome(welcome: Welcome): Uint8Array {
  return encodeMlsMessage({
    welcome,
    wireformat: "mls_welcome",
    version: "mls10",
  });
}

export function decodeWelcome(wire: Uint8Array): Welcome {
  const decoded = decodeMlsMessage(wire, 0)?.[0];
  if (!decoded || decoded.wireformat !== "mls_welcome") {
    throw new Error("mls: expected welcome");
  }
  return decoded.welcome;
}

export function encodeCommit(commit: MLSMessage): Uint8Array {
  return encodeMlsMessage(commit);
}

export async function mlsProcessCommit(
  state: ClientState,
  wire: Uint8Array
): Promise<ClientState> {
  const impl = await mlsCiphersuite();
  const decoded = decodeMlsMessage(wire, 0)?.[0];
  if (!decoded) throw new Error("mls: bad commit message");
  if (
    decoded.wireformat !== "mls_public_message" &&
    decoded.wireformat !== "mls_private_message"
  ) {
    throw new Error("mls: unexpected commit wireformat");
  }
  const result = await processMessage(
    decoded,
    state,
    emptyPskIndex,
    () => "accept",
    impl
  );
  result.consumed.forEach(zeroOutUint8Array);
  return result.newState;
}

// re-export types callers need
export type { ClientState, KeyPackage, Welcome, PrivateMessage, MLSMessage };
