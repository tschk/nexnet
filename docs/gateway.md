# Gateway

The gateway is the first networked Nexnet service that authenticates a caller
before it accepts a post. It serves two channels:

| Channel   | Read       | Write                                       |
| --------- | ---------- | ------------------------------------------- |
| `updates` | any caller | only the configured owner identity          |
| `public`  | any caller | any registered identity with a live session |

Wallet and chain are the primary identity. Passkeys and SSH keys are additional
sign-in methods that must first be authorised by the wallet.

## Configuration

Nothing is defaulted that names an operator, owner or checkpoint.

| Variable                                           | Meaning                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXNET_OWNER_IDENTITY`                            | 64-hex identity id allowed to post to `updates`. Unset: `updates` is closed to every writer.                                                                 |
| `NEXNET_MODE`                                      | `dev-chain` (explicit in-memory development chain) or `chain`.                                                                                               |
| `NEXNET_CHAIN_ENDPOINT`, `NEXNET_CHAIN_CHECKPOINT` | Required for `chain`. The gateway refuses to start in `chain` mode without both, and no chain client exists yet, so `chain` mode currently refuses to start. |
| `NEXNET_RP_ID`, `NEXNET_ORIGINS`                   | WebAuthn relying party and comma-separated allowed origins. Passkey sign-in is disabled when unset.                                                          |
| `NEXNET_STATE_DIR`                                 | Directory for chain state and the message log.                                                                                                               |
| `PORT`                                             | Listen port.                                                                                                                                                 |

## Credentials

```text
wallet (Ed25519 root key = identity)
  -> device certificate        (root signature)              method: wallet
  -> SSH key commitment        (root signature, ed25519 key) method: ssh
  -> passkey commitment        (root signature, COSE key)    method: passkey
```

The root key signs every commitment. Each commitment can be revoked by a
root-signed revocation with a strictly increasing revocation sequence.

## Sign-in

1. `POST /v1/auth/challenge` returns a single-use challenge bound to the method,
   the identity, the device key and this gateway's audience. It expires after
   120 seconds.
2. The caller proves the method over the challenge preimage:
   - `wallet`: the device key signs the challenge; the device certificate must be
     root-signed, unexpired and not revoked.
   - `ssh`: `ssh-keygen -Y sign -n nexnet-auth` over the challenge preimage; the
     SSH key must have a live wallet commitment.
   - `passkey`: a WebAuthn assertion whose challenge is the challenge preimage
     hash; the credential must have a live wallet commitment and the counter
     must advance.
3. `POST /v1/auth/verify` consumes the challenge and returns a bearer session
   token bound to the device. Sessions last at most 12 hours and end on
   `POST /v1/auth/logout` or revocation.

## Posting

`POST /v1/channels/:channel/messages` requires the bearer token and a
device-signed `channel.post` event. The gateway rejects a post when the token is
unknown, expired or revoked; the device certificate or commitment behind the
session is revoked; the event signature, author or device does not match the
session; the sequence does not advance; the event id was already seen; the
timestamp is outside five minutes of gateway time; the identity is not allowed to
write the channel; or the sender exceeds the channel rate limit.

## Reading and streaming

`GET /v1/channels/:channel/messages?limit=` is public. `GET /v1/stream` upgrades
to a WebSocket; the first frame is `{"token": "..."}` or `{}` for read-only, then
the server sends `{"event":"message",...}` frames. Tokens never appear in URLs.

## Known gaps

- The chain is the in-memory `DevChainClient`. The inauguration `.in` app encodes
  pure transition rules only; see [chain.md](chain.md).
- SSH hosting (an `sshd` that terminates the user's SSH connection) is not part
  of the gateway. SSH keys sign in through `ssh-keygen -Y sign`.
- Passkeys are verified by the gateway, but a passkey ceremony needs a browser
  or the macOS bridge; there is no native Linux passkey bridge.
