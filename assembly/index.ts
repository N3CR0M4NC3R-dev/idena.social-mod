import {
    Address,
    Balance,
    BASE_IDNA,
    Bytes,
    Context,
    Host,
    PersistentMap,
    models,
    util,
} from 'idena-sdk-as';
import { Protobuf } from 'as-proto';

// Identities with at least this much stake are moderators automatically. Test builds (`yarn asbuild:test`) lower it
// with `--use TEST_MODERATOR_STAKE_IDNA=0` because the contract runner can't give identities stake; release builds
// never define it.
// @ts-ignore: TEST_MODERATOR_STAKE_IDNA only exists in test builds.
const MODERATOR_STAKE_IDNA: i64 = isDefined(TEST_MODERATOR_STAKE_IDNA) ? TEST_MODERATOR_STAKE_IDNA : 1_000_000;
const MODERATOR_STAKE: Balance = Balance.from(MODERATOR_STAKE_IDNA) * BASE_IDNA;

// Vouches a staker can have in effect at once.
const MAX_VOUCHES: u32 = 5;

const MAX_BAN_EPOCHS: u32 = 65_535;
// In UTF-8 bytes, which bounds storage and the gas the callbacks need.
const MAX_REASON_BYTES: i32 = 280;

// Transactions one banTransactions call can ban. A full batch with maximum-length reasons uses about 130M wasm gas,
// roughly a quarter of a block.
const MAX_TRANSACTION_BATCH: i32 = 100;
// Callback gas per transaction in a banTransactions batch, on top of DEFAULT_CALLBACK_GAS: about 1.5 times what a ban
// with a maximum-length reason uses. Most of it is writing the reason, which is stored with every banned transaction.
const GAS_PER_BATCHED_BAN: u32 = 2_000_000;

const IDENTITY_PROMISE_GAS: u32 = 20_000;
// Covers every callback with room to spare, except that vouching for or revoking an address costs about 60k more per
// voucher it already has: with this default that works up to roughly 50 vouchers (vouch) or 65 (revoke), beyond which
// callers pass a higher _gasLimit. Only gas actually used is charged, but the transaction's maxFee must cover the
// reservation.
const DEFAULT_CALLBACK_GAS: u32 = 4_000_000;

// Stored under 'b:<address>'. Active while `permanent` is set or the current epoch is before `endEpoch`.
class Ban {
    moderator: string = '';
    epoch: u16 = 0; // epoch it was issued in
    permanent: bool = false;
    endEpoch: u32 = 0;
    reason: string = '';
}

// Stored under 't:<transaction hash>'. Lasts until a moderator unbans the transaction.
class TransactionBan {
    moderator: string = '';
    epoch: u16 = 0; // epoch it was issued in
    reason: string = '';
}

class BanArgs {
    address: string = '';
    epochs: u32 = 0; // how many epochs the ban lasts; 0 = permanent
    reason: string = '';
    _gasLimit: u32 = DEFAULT_CALLBACK_GAS;
}

class UnbanArgs {
    address: string = '';
    reason: string = '';
    _gasLimit: u32 = DEFAULT_CALLBACK_GAS;
}

class AddressArgs {
    address: string = '';
    _gasLimit: u32 = DEFAULT_CALLBACK_GAS;
}

class TransactionArgs {
    hash: string = '';
    reason: string = '';
    _gasLimit: u32 = DEFAULT_CALLBACK_GAS;
}

class BanTransactionsArgs {
    hashes: string[] = [];
    reason: string = '';
    _gasLimit: u32 = 0; // 0: DEFAULT_CALLBACK_GAS plus GAS_PER_BATCHED_BAN per transaction
}

class ReportArgs {
    address: string = '';
    reason: string = '';
}

class ReportTransactionArgs {
    hash: string = '';
    reason: string = '';
}

// Lowercase 0x hex, the form every map key takes.
function toKey(bytes: Uint8Array): string {
    return util.toHexString(bytes, true);
}

// Accepts any case, with or without 0x.
function parseHex(value: string, length: i32, error: string): Uint8Array {
    const hex = value.startsWith('0x') || value.startsWith('0X') ? value.substring(2) : value;
    util.assert(hex.length == length * 2, error);
    for (let i = 0; i < hex.length; i++) {
        const c = hex.charCodeAt(i);
        const isHex = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
        util.assert(isHex, error);
    }
    return util.decodeFromHex(hex);
}

function parseAddress(value: string): Address {
    return Address.fromBytes(parseHex(value, 20, 'invalid address'));
}

const HASH_LENGTH: i32 = 32;

function parseTransactionHash(value: string): Bytes {
    return Bytes.fromBytes(parseHex(value, HASH_LENGTH, 'invalid transaction hash'));
}

function requireValidReason(reason: string): void {
    util.assert(String.UTF8.byteLength(reason) <= MAX_REASON_BYTES, 'reason is too long');
}

// The contract never reads the amount sent with a call (Context.payAmount): idena-go gives a call that sends nothing a
// nil amount, and reading it fails the call on mainnet. iDNA sent anyway stays in the contract: nothing can pay it out.

function lookupIdentity(address: Address, callback: string, args: Bytes[], gasLimit: u32): void {
    Host.createGetIdentityPromise(address, IDENTITY_PROMISE_GAS).then(callback, args, Balance.Zero, gasLimit);
}

// Only valid inside a `lookupIdentity` callback. To check a moderator, use `requireLookedUpStake`, which also remembers
// the result for the rest of the epoch.
function lookedUpIdentityHasModeratorStake(): bool {
    const result = Host.promiseResult();
    util.assert(!result.failed(), 'identity lookup failed');
    const identity = Protobuf.decode<models.ProtoStateIdentity>(result.data, models.ProtoStateIdentity.decode);
    return Balance.fromBytes(identity.stake) >= MODERATOR_STAKE;
}

function isBanActive(ban: Ban): bool {
    if (ban.moderator == '') return false;
    return ban.permanent || u32(Context.epoch()) < ban.endEpoch;
}

// Vouches are stored as address lists: 20-byte addresses back to back, which is far cheaper to read and search than
// JSON.
const ADDRESS_LENGTH: i32 = 20;

function vouchKey(address: Address, voucher: Address): string {
    return toKey(address) + ':' + toKey(voucher);
}

function addressCount(list: Uint8Array): u32 {
    return list.length / ADDRESS_LENGTH;
}

function addressAt(list: Uint8Array, index: i32): Address {
    return Address.fromBytes(list.slice(index * ADDRESS_LENGTH, (index + 1) * ADDRESS_LENGTH));
}

function addressIndex(list: Uint8Array, address: Address): i32 {
    for (let i = 0; i < list.length; i += ADDRESS_LENGTH) {
        let j = 0;
        while (j < ADDRESS_LENGTH && list[i + j] == address[j]) j++;
        if (j == ADDRESS_LENGTH) return i / ADDRESS_LENGTH;
    }
    return -1;
}

function withAddress(list: Uint8Array, address: Address): Uint8Array {
    const result = new Uint8Array(list.length + ADDRESS_LENGTH);
    result.set(list);
    result.set(address, list.length);
    return result;
}

function withoutAddressAt(list: Uint8Array, index: i32): Uint8Array {
    const start = index * ADDRESS_LENGTH;
    const result = new Uint8Array(list.length - ADDRESS_LENGTH);
    result.set(list.subarray(0, start));
    result.set(list.subarray(start + ADDRESS_LENGTH), start);
    return result;
}

// The contract's storage. The maps are module constants rather than fields of the contract class because every call and
// callback loads the class's fields from storage and parses them, maps included: as fields, each map added about 1,250
// gas to every call and callback. Every map is keyed by lowercase 0x address unless noted.
const bans = PersistentMap.withStringPrefix<string, Ban>('b:');
// Keyed by lowercase 0x transaction hash.
const transactionBans = PersistentMap.withStringPrefix<string, TransactionBan>('t:');
// Each address's current vouchers. A vouch is in effect exactly while its voucher is listed here.
const vouchers = PersistentMap.withStringPrefix<string, Uint8Array>('m:');
// The addresses each staker has vouched for, to enforce MAX_VOUCHES. After a revocation an address can linger here until
// the list is next written; it only counts while its vouch record still exists.
const vouchesGiven = PersistentMap.withStringPrefix<string, Uint8Array>('v:');
// Keyed '<address>:<voucher>', present exactly while that vouch is in effect. Checking it is far cheaper than reading
// the address's whole voucher list, since storage reads are charged per byte.
const vouchRecords = PersistentMap.withStringPrefix<string, u8>('p:');
// The epoch an identity lookup last found each address with MODERATOR_STAKE. For the rest of that epoch it moderates
// without a lookup. Only stakers are stored: stake can be added at any time, so a failed check isn't remembered.
const stakeEpochs = PersistentMap.withStringPrefix<string, u16>('s:');

export class IdenaSocialMod {
    // The class keeps no fields (see the maps above). The constructor is what makes the SDK export `deploy`.
    constructor() {}

    // Bans `address` for `epochs` epochs, or permanently when 0. Moderators can't be banned: stakers never, and a
    // vouched moderator only once a staker has revoked their vouches.
    ban(args: BanArgs): void {
        const caller = Context.caller();
        const target = parseAddress(args.address);
        util.assert(target != caller, 'cannot ban yourself');
        util.assert(args.epochs <= MAX_BAN_EPOCHS, 'ban is too long');
        requireValidReason(args.reason);
        this.requireNotBanned(caller);
        util.assert(!this.isKnownModerator(toKey(target)), 'cannot ban a moderator');

        // Check the target isn't a staker, then that the caller is a moderator. The target is always looked up: only
        // confirmed stakers are remembered, so an address that isn't one could have staked since.
        const callbackArgs: Bytes[] = [
            caller.toBytes(),
            target.toBytes(),
            Bytes.fromU32(args.epochs),
            Bytes.fromU32(args._gasLimit),
            Bytes.fromString(args.reason),
        ];
        lookupIdentity(target, '_banCheckTarget', callbackArgs, args._gasLimit * 2 + IDENTITY_PROMISE_GAS);
    }

    @privateMethod
    _banCheckTarget(caller: Address, target: Address, epochs: u32, gasLimit: u32, reason: string = ''): void {
        util.assert(!lookedUpIdentityHasModeratorStake(), 'cannot ban a moderator');
        if (this.isKnownModerator(toKey(caller))) {
            this.applyBan(target, caller, epochs, reason);
        } else {
            const callbackArgs: Bytes[] = [
                caller.toBytes(),
                target.toBytes(),
                Bytes.fromU32(epochs),
                Bytes.fromU32(gasLimit),
                Bytes.fromString(reason),
            ];
            lookupIdentity(caller, '_banAsStaker', callbackArgs, gasLimit);
        }
    }

    @privateMethod
    _banAsStaker(caller: Address, target: Address, epochs: u32, gasLimit: u32, reason: string = ''): void {
        this.requireLookedUpStake(caller, 'only moderators can ban');
        this.applyBan(target, caller, epochs, reason);
    }

    // Lifts a ban. The optional reason goes in the unban event; the ban record itself is deleted.
    unban(args: UnbanArgs): void {
        const caller = Context.caller();
        const target = parseAddress(args.address);
        requireValidReason(args.reason);
        this.requireNotBanned(caller);
        util.assert(this.isBanned(target), 'address is not banned');

        if (this.isKnownModerator(toKey(caller))) {
            this.applyUnban(target, caller, args.reason);
        } else {
            const callbackArgs: Bytes[] = [caller.toBytes(), target.toBytes(), Bytes.fromString(args.reason)];
            lookupIdentity(caller, '_unbanAsStaker', callbackArgs, args._gasLimit);
        }
    }

    @privateMethod
    _unbanAsStaker(caller: Address, target: Address, reason: string = ''): void {
        this.requireLookedUpStake(caller, 'only moderators can unban');
        this.applyUnban(target, caller, reason);
    }

    // Bans a transaction (a post, reply, message or any other idena.social action) by its hash, until a moderator
    // unbans it. The contract can't see who sent a transaction, so any transaction can be banned, a moderator's
    // included. Its sender isn't banned.
    banTransaction(args: TransactionArgs): void {
        const caller = Context.caller();
        const hash = parseTransactionHash(args.hash);
        requireValidReason(args.reason);
        this.requireNotBanned(caller);
        util.assert(!this.isTransactionBanned(hash), 'transaction is already banned');

        if (this.isKnownModerator(toKey(caller))) {
            this.applyTransactionBan(hash, caller, args.reason);
        } else {
            const callbackArgs: Bytes[] = [caller.toBytes(), hash, Bytes.fromString(args.reason)];
            lookupIdentity(caller, '_banTransactionAsStaker', callbackArgs, args._gasLimit);
        }
    }

    @privateMethod
    _banTransactionAsStaker(caller: Address, hash: Bytes, reason: string = ''): void {
        this.requireLookedUpStake(caller, 'only moderators can ban transactions');
        this.applyTransactionBan(hash, caller, reason);
    }

    // Bans up to MAX_TRANSACTION_BATCH transactions at once with one reason, e.g. to clean up after banning an account.
    // Transactions already banned are skipped, so a list can be sent again as is.
    banTransactions(args: BanTransactionsArgs): void {
        const caller = Context.caller();
        const count = args.hashes.length;
        util.assert(count > 0, 'no transactions to ban');
        util.assert(count <= MAX_TRANSACTION_BATCH, 'too many transactions');
        requireValidReason(args.reason);
        this.requireNotBanned(caller);

        // Every hash is checked before anything is banned. They travel to the callback as one run of 32-byte hashes.
        const hashes = new Uint8Array(count * HASH_LENGTH);
        for (let i = 0; i < count; i++) hashes.set(parseTransactionHash(args.hashes[i]), i * HASH_LENGTH);

        if (this.isKnownModerator(toKey(caller))) {
            this.applyTransactionBans(hashes, caller, args.reason);
        } else {
            const gasLimit = args._gasLimit > 0 ? args._gasLimit : DEFAULT_CALLBACK_GAS + GAS_PER_BATCHED_BAN * u32(count);
            const callbackArgs: Bytes[] = [caller.toBytes(), Bytes.fromBytes(hashes), Bytes.fromString(args.reason)];
            lookupIdentity(caller, '_banTransactionsAsStaker', callbackArgs, gasLimit);
        }
    }

    @privateMethod
    _banTransactionsAsStaker(caller: Address, hashes: Bytes, reason: string = ''): void {
        this.requireLookedUpStake(caller, 'only moderators can ban transactions');
        this.applyTransactionBans(hashes, caller, reason);
    }

    // Lifts a transaction ban. The optional reason goes in the unbanTransaction event; the ban record is deleted.
    unbanTransaction(args: TransactionArgs): void {
        const caller = Context.caller();
        const hash = parseTransactionHash(args.hash);
        requireValidReason(args.reason);
        this.requireNotBanned(caller);
        util.assert(this.isTransactionBanned(hash), 'transaction is not banned');

        if (this.isKnownModerator(toKey(caller))) {
            this.applyTransactionUnban(hash, caller, args.reason);
        } else {
            const callbackArgs: Bytes[] = [caller.toBytes(), hash, Bytes.fromString(args.reason)];
            lookupIdentity(caller, '_unbanTransactionAsStaker', callbackArgs, args._gasLimit);
        }
    }

    @privateMethod
    _unbanTransactionAsStaker(caller: Address, hash: Bytes, reason: string = ''): void {
        this.requireLookedUpStake(caller, 'only moderators can unban transactions');
        this.applyTransactionUnban(hash, caller, reason);
    }

    // Reports an address to the moderators. Reports are only emitted as events; nothing is stored. Anyone without an
    // active ban can report, and a reason is required.
    report(args: ReportArgs): void {
        const caller = Context.caller();
        const target = parseAddress(args.address);
        util.assert(target != caller, 'cannot report yourself');
        this.requireReport(caller, args.reason);
        Host.emitEvent('report', [target.toBytes(), caller.toBytes(), Bytes.fromString(args.reason)]);
    }

    // Reports a transaction (a post, reply, message or any other idena.social action) by its hash, like `report`.
    reportTransaction(args: ReportTransactionArgs): void {
        const caller = Context.caller();
        const hash = parseTransactionHash(args.hash);
        this.requireReport(caller, args.reason);
        Host.emitEvent('reportTransaction', [hash, caller.toBytes(), Bytes.fromString(args.reason)]);
    }

    // Makes `address` a moderator for as long as at least one vouch for it remains. Only stakers can vouch, and each
    // can have MAX_VOUCHES vouches in effect at once.
    vouch(args: AddressArgs): void {
        const caller = Context.caller();
        const target = parseAddress(args.address);
        util.assert(target != caller, 'cannot vouch for yourself');
        this.requireNotBanned(caller);
        util.assert(!this.isBanned(target), 'cannot vouch for a banned address');
        util.assert(!this.hasVouched(caller, target), 'already vouched');
        const callerVouches = this.currentVouches(caller);
        util.assert(addressCount(callerVouches) < MAX_VOUCHES, 'vouch limit reached');

        if (this.hasConfirmedStake(toKey(caller))) {
            this.applyVouch(target, caller, callerVouches);
        } else {
            lookupIdentity(caller, '_vouchAsStaker', [caller.toBytes(), target.toBytes()], args._gasLimit);
        }
    }

    @privateMethod
    _vouchAsStaker(caller: Address, target: Address): void {
        this.requireLookedUpStake(caller, 'only identities with 1M+ iDNA stake can vouch');
        this.applyVouch(target, caller, this.currentVouches(caller));
    }

    // Withdraws the caller's own vouch. Allowed even if the caller is banned or no longer a staker.
    withdrawVouch(args: AddressArgs): void {
        const caller = Context.caller();
        const target = parseAddress(args.address);
        util.assert(this.hasVouched(caller, target), 'no vouch to withdraw');

        vouchRecords.delete(vouchKey(target, caller));
        const targetKey = toKey(target);
        let targetVouchers = vouchers.get(targetKey, new Uint8Array(0));
        targetVouchers = withoutAddressAt(targetVouchers, addressIndex(targetVouchers, caller));
        this.setList(vouchers, targetKey, targetVouchers);
        // With the vouch record gone, currentVouches leaves the target out.
        this.setList(vouchesGiven, toKey(caller), this.currentVouches(caller));
        Host.emitEvent('vouchWithdrawn', [target.toBytes(), caller.toBytes(), Bytes.fromU32(addressCount(targetVouchers))]);
    }

    // Removes every vouch for `address`, whoever made them, which frees those vouchers' slots. Only stakers can do this.
    revokeVouches(args: AddressArgs): void {
        const caller = Context.caller();
        const target = parseAddress(args.address);
        this.requireNotBanned(caller);
        util.assert(this.isVouched(toKey(target)), 'address has no vouches');

        if (this.hasConfirmedStake(toKey(caller))) {
            this.applyRevokeVouches(target, caller);
        } else {
            lookupIdentity(caller, '_revokeVouchesAsStaker', [caller.toBytes(), target.toBytes()], args._gasLimit);
        }
    }

    @privateMethod
    _revokeVouchesAsStaker(caller: Address, target: Address): void {
        this.requireLookedUpStake(caller, 'only identities with 1M+ iDNA stake can revoke vouches');
        this.applyRevokeVouches(target, caller);
    }

    @view
    isBanned(address: Address): bool {
        return isBanActive(bans.get(toKey(address), new Ban()));
    }

    @view
    isTransactionBanned(hash: Bytes): bool {
        return transactionBans.get(toKey(hash), new TransactionBan()).moderator != '';
    }

    // Moderators by vouch have a count above 0. Moderators by stake can't be checked here: stake is only readable
    // through an async identity lookup.
    @view
    vouchCount(address: Address): u32 {
        return addressCount(vouchers.get(toKey(address), new Uint8Array(0)));
    }

    @view
    hasVouched(voucher: Address, address: Address): bool {
        return vouchRecords.get(vouchKey(address, voucher), 0) != 0;
    }

    private isVouched(addressKey: string): bool {
        return vouchers.get(addressKey, new Uint8Array(0)).length > 0;
    }

    // Whether an identity lookup has found the address with moderator stake this epoch.
    private hasConfirmedStake(addressKey: string): bool {
        const epoch = Context.epoch();
        // The default only has to differ from the current epoch.
        return stakeEpochs.get(addressKey, u16(epoch + 1)) == epoch;
    }

    // A moderator that needs no identity lookup: vouched, or confirmed as a staker this epoch.
    private isKnownModerator(addressKey: string): bool {
        return this.isVouched(addressKey) || this.hasConfirmedStake(addressKey);
    }

    // Only valid inside a `lookupIdentity` callback for `address`. Fails with `error` unless the identity has moderator
    // stake, and otherwise remembers that for the rest of the epoch.
    private requireLookedUpStake(address: Address, error: string): void {
        util.assert(lookedUpIdentityHasModeratorStake(), error);
        stakeEpochs.set(toKey(address), Context.epoch());
    }

    private requireNotBanned(address: Address): void {
        util.assert(!this.isBanned(address), 'banned addresses cannot moderate');
    }

    private requireReport(reporter: Address, reason: string): void {
        util.assert(reason.length > 0, 'reason is required');
        requireValidReason(reason);
        util.assert(!this.isBanned(reporter), 'banned addresses cannot report');
    }

    // Stores an address list, or deletes it once empty.
    private setList(map: PersistentMap<string, Uint8Array>, key: string, list: Uint8Array): void {
        if (list.length == 0) {
            map.delete(key);
        } else {
            map.set(key, list);
        }
    }

    // The addresses `voucher` has vouched for whose vouch is still in effect.
    private currentVouches(voucher: Address): Uint8Array {
        const stored = vouchesGiven.get(toKey(voucher), new Uint8Array(0));
        let current = new Uint8Array(0);
        for (let i = 0; i < i32(addressCount(stored)); i++) {
            const address = addressAt(stored, i);
            if (this.hasVouched(voucher, address)) current = withAddress(current, address);
        }
        return current;
    }

    private applyBan(target: Address, moderator: Address, epochs: u32, reason: string): void {
        const epoch = Context.epoch();
        const ban = new Ban();
        ban.moderator = toKey(moderator);
        ban.epoch = epoch;
        ban.permanent = epochs == 0;
        ban.endEpoch = epochs == 0 ? 0 : u32(epoch) + epochs;
        ban.reason = reason;
        bans.set(toKey(target), ban);
        Host.emitEvent('ban', [
            target.toBytes(),
            moderator.toBytes(),
            Bytes.fromU16(ban.epoch),
            Bytes.fromU8(ban.permanent ? 1 : 0),
            Bytes.fromU32(ban.endEpoch),
            Bytes.fromString(reason),
        ]);
    }

    // `voucherVouches` is the voucher's current vouches, before this one.
    private applyVouch(target: Address, voucher: Address, voucherVouches: Uint8Array): void {
        vouchesGiven.set(toKey(voucher), withAddress(voucherVouches, target));
        vouchRecords.set(vouchKey(target, voucher), 1);
        const targetKey = toKey(target);
        const targetVouchers = withAddress(vouchers.get(targetKey, new Uint8Array(0)), voucher);
        vouchers.set(targetKey, targetVouchers);
        Host.emitEvent('vouch', [target.toBytes(), voucher.toBytes(), Bytes.fromU32(addressCount(targetVouchers))]);
    }

    private applyRevokeVouches(target: Address, staker: Address): void {
        const targetKey = toKey(target);
        const targetVouchers = vouchers.get(targetKey, new Uint8Array(0));
        const revoked = addressCount(targetVouchers);
        for (let i = 0; i < i32(revoked); i++) {
            vouchRecords.delete(vouchKey(target, addressAt(targetVouchers, i)));
        }
        vouchers.delete(targetKey);
        Host.emitEvent('vouchesRevoked', [target.toBytes(), staker.toBytes(), Bytes.fromU32(revoked)]);
    }

    private applyTransactionBan(hash: Bytes, moderator: Address, reason: string): void {
        const ban = new TransactionBan();
        ban.moderator = toKey(moderator);
        ban.epoch = Context.epoch();
        ban.reason = reason;
        transactionBans.set(toKey(hash), ban);
        Host.emitEvent('banTransaction', [hash, moderator.toBytes(), Bytes.fromU16(ban.epoch), Bytes.fromString(reason)]);
    }

    // Bans each 32-byte hash in `hashes` that isn't banned already.
    private applyTransactionBans(hashes: Uint8Array, moderator: Address, reason: string): void {
        for (let i = 0; i < hashes.length; i += HASH_LENGTH) {
            const hash = Bytes.fromBytes(hashes.slice(i, i + HASH_LENGTH));
            if (!this.isTransactionBanned(hash)) this.applyTransactionBan(hash, moderator, reason);
        }
    }

    private applyTransactionUnban(hash: Bytes, moderator: Address, reason: string): void {
        transactionBans.delete(toKey(hash));
        Host.emitEvent('unbanTransaction', [hash, moderator.toBytes(), Bytes.fromString(reason)]);
    }

    private applyUnban(target: Address, moderator: Address, reason: string): void {
        bans.delete(toKey(target));
        Host.emitEvent('unban', [target.toBytes(), moderator.toBytes(), Bytes.fromString(reason)]);
    }
}
