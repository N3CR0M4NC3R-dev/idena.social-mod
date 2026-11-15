# idena.social-mod

Content moderation smart contract for idena.social.

It's an on-chain record of moderation decisions: which addresses and which transactions are banned, and who the moderators are. Users can also report addresses and transactions to the moderators. It doesn't hide anything itself; the idena.social UI or API reads it and decides what to show. It has no owner or admin: everything is governed by stake and vouches.

Smart Contract is live: https://scan.idena.io/contract/0x2D063782FC18Fe29be8aaF65df9CDd3a1c53Bf6d

## Who can do what

There are two kinds of moderator:

- **Stakers:** any identity with at least 1,000,000 iDNA staked. Stake is checked live on every action, so this updates on its own as stakes change.
- **Vouched moderators:** any address that at least one staker has vouched for.

| Action | Staker | Vouched moderator |
| --- | --- | --- |
| Ban an address (for a number of epochs or permanently, optional reason) | ✓ | ✓ |
| Unban an address (optional reason) | ✓ | ✓ |
| Ban or unban a single transaction (bans last until lifted; optional reason either way) | ✓ | ✓ |
| Ban up to 100 transactions at once, with one reason (e.g. to clean up a banned account's posts) | ✓ | ✓ |
| Vouch for an address (at most 5 vouches in effect at a time) | ✓ | — |
| Revoke every vouch for an address | ✓ | — |
| Withdraw a vouch you made | ✓ (even if banned or no longer a staker) | — |

Anyone who isn't banned, moderator or not, can **report** an address or a transaction, with a reason.

## Rules

- **Moderators can't be banned.** Stakers never can be. A vouched moderator first has to have their vouches revoked by a staker, which turns them into an ordinary address.
- **Banned addresses can't moderate.** They can't ban or unban (addresses or transactions), vouch or revoke, and can't be vouched for. They can still withdraw vouches they made.
- **Transaction bans cover any transaction** (a post, reply, message or any other idena.social action), including a moderator's, because the contract can't see who sent a transaction. Only that piece of content is affected, not the sender.
- **Address bans expire by themselves** at their end epoch. Banning an already-banned address replaces the old ban.
- **Reports are only events.** Nothing is stored, so the contract doesn't count or deduplicate them; the idena.social API collects them from the `report` and `reportTransaction` events. A report doesn't ban anything by itself.
- **Vouches persist** if the voucher's stake later drops. Withdrawing a vouch, or a staker revoking it, frees the voucher's slot.
- **Guards:** you can't ban, vouch for or report yourself, and reasons are capped at 280 UTF-8 bytes.
- **Send 0 iDNA.** The contract never reads the amount sent with a call: idena-go gives a call that sends nothing a nil amount, and reading it fails the call on mainnet (the contract runner doesn't reproduce this). iDNA sent anyway stays in the contract, which can't pay it out.

## Methods

Each method takes one JSON string argument, like the idena.social contract. `address` accepts any case, with or without `0x`.

| Method | Argument | Who can call |
| --- | --- | --- |
| `ban` | `{ address, epochs?, reason? }` | Moderators. `epochs` is how many epochs the ban lasts (1 ends it at the next epoch); omit it or pass 0 for a permanent ban. |
| `unban` | `{ address, reason? }` | Moderators. The reason is only recorded in the `unban` event, since the ban record is deleted. |
| `banTransaction` | `{ hash, reason? }` | Moderators. `hash` is the transaction hash, in any case, with or without `0x`. |
| `banTransactions` | `{ hashes, reason? }` | Moderators. Bans up to 100 transactions in one call, all with the same reason. Hashes already banned (or repeated) are skipped, so a list can be sent again as is; one malformed hash fails the whole call. |
| `unbanTransaction` | `{ hash, reason? }` | Moderators. The reason is only recorded in the `unbanTransaction` event. |
| `vouch` | `{ address }` | Stakers. |
| `withdrawVouch` | `{ address }` | Whoever made the vouch. |
| `revokeVouches` | `{ address }` | Stakers. |
| `report` | `{ address, reason }` | Anyone who isn't banned. The reason is required. |
| `reportTransaction` | `{ hash, reason }` | Anyone who isn't banned. The reason is required. |

### Asynchronous checks

Stake can only be read through an identity lookup promise, so a check that depends on stake runs in a callback. A callback that rejects the action does **not** fail the transaction: the receipt still says `success: true`. To confirm an action took effect, look for its event; the rejection reason is in `actionResult.subActionResults[].error`.

`ban` always looks up the target (to make sure it isn't a staker), and then the caller too unless they're a vouched moderator. `unban`, `banTransaction`, `banTransactions` and `unbanTransaction` look up the caller unless they're a vouched moderator. `vouch` and `revokeVouches` always look up the caller.

The callbacks (the methods starting with `_`) can't be called directly: the VM refuses `_` methods outside a callback, and `@privateMethod` also checks that the caller is the contract itself.

Each callback gets `_gasLimit` wasm gas, which defaults to 4,000,000 and can be set in the argument. That covers every callback with room to spare, with one exception: vouching for or revoking an address costs about 60,000 more for each voucher it already has. The default works up to roughly 40 existing vouchers for `vouch` and 60 for `revokeVouches`; beyond that, pass a higher `_gasLimit`.

`banTransactions` sizes its callback gas automatically: 4,000,000 plus 2,000,000 per transaction, unless `_gasLimit` is set. Most of a transaction ban's cost is writing its reason, which is stored with every banned transaction: from about 500,000 wasm gas per transaction with no reason to about 1,400,000 with a maximum-length one. A full batch of 100 with long reasons uses about 130M wasm gas, roughly a quarter of a block. A vouched moderator's batch runs inside the call itself, so it simply needs a `maxFee` that covers it.

Only gas actually used is charged, but the transaction's `maxFee` has to cover the reservation: up to `2 × _gasLimit` for `ban`, and about 204M wasm gas for a full `banTransactions` batch from a staker.

## Reading state

Read state with `contract_readMap(contract, map, key, format)`. Keys use lowercase `0x` addresses (or transaction hashes), encoded as UTF-8 and hex-encoded for the RPC call.

| Map | Key | Format | Value |
| --- | --- | --- | --- |
| `b:` | address | `string` | Ban, as JSON: `{ moderator, epoch, permanent, endEpoch, reason }`. The ban is active while `permanent` is true or the current epoch is below `endEpoch`. |
| `t:` | transaction hash | `string` | Transaction ban, as JSON: `{ moderator, epoch, reason }`. The transaction is banned while this exists. |
| `m:` | address | `hex` | **Who vouched for the address**, as an address list. The address is a vouched moderator while the list is non-empty; it's removed once empty. |
| `v:` | voucher | `hex` | The addresses a staker has vouched for, as an address list. After a revocation an address can linger here until the list next changes; it only counts while `m:<that address>` still lists the staker. |
| `p:` | `<address>:<voucher>` | `hex` | `0x01` while that vouch is in effect. The contract uses it to check vouches without reading whole lists. |

An address list is 20-byte addresses back to back, so split the hex after `0x` into 40-character chunks. Lists are stored as bytes rather than JSON because the chain charges for every byte read and written.

Whether an address is a staker isn't stored. Check its stake with the `dna_identity` RPC.

The `@view` methods (`isBanned`, `isTransactionBanned`, `vouchCount`, `hasVouched`) are for other contracts to call through `createCallFunctionPromise`. The node's `contract_readonlyCall` only supports built-in contracts.

## Events

The maps above only hold the current state. Events give the full history, including who lifted a ban and why, and bans that were later replaced.

Addresses are 20 bytes, numbers are little-endian, booleans are 1 byte and text is UTF-8.

| Event | Args |
| --- | --- |
| `ban` | address, moderator, epoch (u16), permanent (bool), endEpoch (u32), reason |
| `unban` | address, moderator, reason |
| `banTransaction` | transaction hash (32 bytes), moderator, epoch (u16), reason. `banTransactions` emits one per transaction it bans. |
| `unbanTransaction` | transaction hash (32 bytes), moderator, reason |
| `vouch` / `vouchWithdrawn` | address, voucher, vouch count (u32) |
| `vouchesRevoked` | address, staker, vouches revoked (u32) |
| `report` | address, reporter, reason |
| `reportTransaction` | transaction hash (32 bytes), reporter, reason |

## Limits

- **No owner, pause or upgrade.** Moving to a new contract means deploying it and migrating the bans across. The new contract can read each ban directly from this one's storage, so the migration needs no trust.
- **No stored history.** Unbans and replaced bans only survive in events.

## Build

```
yarn install
yarn asbuild:release   # build/release/idena.social-mod.wasm
```

The build uses `asb`, which bundles the AssemblyScript compiler version the idena SDK transforms are written for. Running `asc` 0.27 directly fails on current Node versions.

## Test

The tests run against [idena-contract-runner](https://github.com/idena-network/idena-contract-runner) on `localhost:3333`:

```
yarn test   # builds both targets, then runs jest
```

The runner can't give identities stake, so `yarn asbuild:test` also produces `build/test/idena.social-mod.wasm`. In that build the stake threshold is 0, which makes every address a staker. Tests that need stakers run against it; everything else runs against the release build. The test build is for testing only; never deploy it.
