# Profiles (AD-24)

## First release fields

| Field        | v1                                                      |
| ------------ | ------------------------------------------------------- |
| username     | yes (on-chain label)                                    |
| identity_id  | yes                                                     |
| **bio**      | **yes** — short text, client-stored / discovery profile |
| display name | omit (use username)                                     |
| **avatar**   | **no**                                                  |

Suggested bio limit until OD-22 locks: **160 graphemes**, plain text, no
remote images.

Bio is not blockchain state. Publish via discovery profile APIs; may be
unsigned local fluff or signed profile statement (implementation choice —
prefer signed by device cert for tamper evidence).

## Non-goals v1

- avatar upload or hash
- rich markdown bios
- verified badges
