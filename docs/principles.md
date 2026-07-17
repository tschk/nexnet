# Core principles

## Local-first

Private message history is stored locally on user devices.

There is no canonical server-side conversation history.

## Peer-to-peer by default

Messages and attachments travel directly between peers whenever possible.

Official relays may assist with signalling, NAT traversal, and optional
privacy routing, but must not become permanent private message stores.

## End-to-end encrypted

Private messages, private group messages, device synchronisation, and
attachments must be end-to-end encrypted.

Relays must not receive plaintext content or long-term decryption keys.

## Cryptographic identity

A user's account is rooted in a cryptographic wallet identity.

Messages are signed by authorised device keys so recipients can verify
authorship and integrity.

## Immutable communication

Messages cannot be edited or unsent after transmission.

There is no protocol-level delete-for-everyone operation.

Local deletion may remove a message from one device only.

## Minimal social state

Supported in the product direction:

- exact online presence
- delivered receipts

Not in the initial release:

- read receipts
- last-seen timestamps
- typing indicators

## Open protocol

The Nexnet protocol, client, node, relay, blockchain, and associated schemas
must be open source.

Independent implementations should be possible.

## User-facing access is free

The standard user experience should not require payment.

Infrastructure may be funded through protocol treasury reserves, token
emissions, grants, donations, or other ecosystem funding mechanisms.
