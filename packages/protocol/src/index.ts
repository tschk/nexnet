/**
 * @nexnet/protocol — protocol operations
 */
export { cdeEncode, cdeDecode } from "./cde.js";
export { signEvent, verifyEvent, verifyEventId, validateEventLimits } from "./event.js";
export {
  authorizePasskeyCredential,
  issueDeviceCert,
  verifyDeviceCert,
  verifyPasskeyCredentialAuthorization,
} from "./device-cert.js";
export {
  identityIdFromWallet,
  signIdentityProof,
  signInPreimage,
  signRevocation,
  signSshCommitment,
  verifyIdentityProof,
  verifyRevocation,
  verifySshCommitment,
} from "./credentials.js";
export type { SignInChallengeFields, SignInMethod } from "./credentials.js";
export {
  SSH_SIGNATURE_NAMESPACE,
  formatSshPublicKey,
  parseSshPublicKey,
  sshFingerprint,
  sshPublicKeyBlob,
  verifySshSignature,
} from "./ssh.js";
export {
  certificateToJson,
  eventToJson,
  fromBase64Url,
  fromHex,
  revocationToJson,
  toBase64Url,
  toHex,
} from "./wire.js";
