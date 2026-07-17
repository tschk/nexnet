# Nexnet chain app (`.in`)

Application logic for scarce public state. **No private chat content.**

## Status

Pure transition rules in `nexnet_chain.in`. Maps/storage land when inauguration
state primitives mature; executor may keep state off-language until then.

## Rules encoded

| Code | Meaning |
|------|---------|
| 0 | ok |
| 1 | username too short |
| 2 | username too long |
| 3 | wallet already owns username (AD-10) |
| 4 | account younger than 7d |
| 5 | username taken (owner active) |
| 10 | transfer disabled |
| 11 | group creator already set (AD-23) |
| 12 | relay key empty (AD-22) |
| 13 | identity root already bound |

Constants:

- `MIN_ACCOUNT_AGE_MS` = 7 days
- `INACTIVITY_RELEASE_MS` = 90 days

## Run self-check

```bash
in execute --path chain/nexnet_chain.in
# expect exit / return 0
```

## Client mirror

`packages/client/src/chain-stub.ts` (`DevChainClient`) implements the same
rules in TypeScript for local dev until the `.in` executor is wired.
