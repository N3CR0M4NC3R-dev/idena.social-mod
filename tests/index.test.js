const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { ContractRunnerProvider, ContractArgumentFormat } = require('idena-sdk-tests');

// Needs idena-contract-runner listening on localhost:3333.
const provider = ContractRunnerProvider.create('http://localhost:3333', '');

const MAX_FEE = '9999';
// The runner's first validation ceremony is in 2099, so every test runs in epoch 0.
const EPOCH = 0;

const randomAddress = () => `0x${crypto.randomBytes(20).toString('hex')}`;
const randomHash = () => `0x${crypto.randomBytes(32).toString('hex')}`;
const hexOf = (text) => `0x${Buffer.from(text).toString('hex')}`;
const bytesOf = (hex) => Buffer.from(hex.replace(/^0x/, ''), 'hex');
const textOf = (hex) => bytesOf(hex).toString();
const u8Of = (hex) => bytesOf(hex).readUInt8(0);
const u16Of = (hex) => bytesOf(hex).readUInt16LE(0);
const u32Of = (hex) => bytesOf(hex).readUInt32LE(0);

async function deploy(target) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'build', target, 'idena.social-mod.wasm'));

    await provider.Chain.generateBlocks(1);
    await provider.Chain.resetTo(2);

    const tx = await provider.Contract.deploy('0', MAX_FEE, code, Buffer.from(''));
    await provider.Chain.generateBlocks(1);
    const receipt = await provider.Chain.receipt(tx);
    expect(receipt.success).toBe(true);

    const god = (await provider.Chain.godAddress()).toLowerCase();
    return { contract: receipt.contract, god };
}

async function send(contract, method, args, amount = '0', maxFee = MAX_FEE) {
    const tx = await provider.Contract.call(contract, method, amount, maxFee, args);
    await provider.Chain.generateBlocks(1);
    return provider.Chain.receipt(tx);
}

const call = (contract, method, args, amount, maxFee) =>
    send(contract, method, [{ index: 0, format: ContractArgumentFormat.String, value: JSON.stringify(args) }], amount, maxFee);

// Views can't be read with contract_readonlyCall (the node only supports that for built-in contracts), so they're
// called in a transaction and read from its output.
async function view(contract, method, ...addresses) {
    const receipt = await send(contract, method, addresses.map((value, index) => ({ index, format: ContractArgumentFormat.Hex, value })));
    expect(receipt.success).toBe(true);
    return receipt.actionResult.outputData;
}
const isBanned = async (contract, address) => textOf(await view(contract, 'isBanned', address)) === 'true';
const hasVouched = async (contract, voucher, address) => textOf(await view(contract, 'hasVouched', voucher, address)) === 'true';
const vouchCount = async (contract, address) => u32Of(await view(contract, 'vouchCount', address));
const isTransactionBanned = async (contract, hash) => textOf(await view(contract, 'isTransactionBanned', hash)) === 'true';

// A failing identity callback doesn't fail the transaction, so a receipt can report success while the moderation
// action was rejected. This collects errors from the call and every callback it triggered.
function errorsOf(receipt) {
    const errors = [];
    const walk = (result) => {
        if (!result) return;
        if (result.error) errors.push(result.error);
        (result.subActionResults || []).forEach(walk);
    };
    if (receipt.error) errors.push(receipt.error);
    walk(receipt.actionResult);
    return errors;
}

// Identity lookups the call made, including ones made from callbacks.
function identityLookupsOf(receipt) {
    const IDENTITY_PROMISE = 5;
    let count = 0;
    const walk = (result) => {
        for (const sub of result.subActionResults || []) {
            if (sub.inputAction.actionType === IDENTITY_PROMISE) count++;
            walk(sub);
        }
    };
    walk(receipt.actionResult);
    return count;
}

// The runner doesn't enable consensus Upgrade 12, so events emitted in a nested callback are reported twice. Mainnet
// reports them once.
function eventsOf(receipt, name) {
    const seen = new Set();
    return (receipt.events || [])
        .filter((event) => event.event === name)
        .filter((event) => {
            const key = JSON.stringify(event.args);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .map((event) => event.args);
}

async function readMap(contract, prefix, key) {
    try {
        return JSON.parse(await provider.Contract.readMap(contract, prefix, hexOf(key), 'string'));
    } catch (error) {
        if (error.message === 'data is nil') return null;
        throw error;
    }
}

async function readList(contract, prefix, key) {
    try {
        const hex = await provider.Contract.readMap(contract, prefix, hexOf(key), 'hex');
        return hex.slice(2).match(/.{40}/g).map((address) => `0x${address}`);
    } catch (error) {
        if (error.message === 'data is nil') return null;
        throw error;
    }
}

// The epoch an identity lookup last confirmed `address` as a staker, or null.
async function readStakeEpoch(contract, address) {
    try {
        return u16Of(await provider.Contract.readMap(contract, 's:', hexOf(address), 'hex'));
    } catch (error) {
        if (error.message === 'data is nil') return null;
        throw error;
    }
}

const seed = (contract, key, value) => provider.Chain.setContractData(contract, key, JSON.stringify(value), 'string');
const seedTransactionBan = (contract, hash) => seed(contract, `t:${hash}`, { moderator: randomAddress(), epoch: EPOCH, reason: '' });
const seedBan = (contract, address, ban) =>
    seed(contract, `b:${address}`, {
        moderator: randomAddress(),
        epoch: EPOCH,
        permanent: false,
        endEpoch: 0,
        reason: '',
        ...ban,
    });
// Vouches are stored as address lists ('m:' and 'v:'): 20-byte addresses back to back.
const seedList = (contract, key, addresses) =>
    provider.Chain.setContractData(contract, key, `0x${addresses.map((address) => address.slice(2)).join('')}`, 'hex');
const seedVouchRecord = (contract, address, voucher) =>
    provider.Chain.setContractData(contract, `p:${address}:${voucher}`, '0x01', 'hex');
// Seeds `vouchers` as the current vouchers of `address`.
async function seedVouchers(contract, address, vouchers) {
    await seedList(contract, `m:${address}`, vouchers);
    for (const voucher of vouchers) await seedVouchRecord(contract, address, voucher);
}
// Records `address` as confirmed to have moderator stake in `epoch`, as an identity lookup would.
function seedStakeEpoch(contract, address, epoch = EPOCH) {
    const value = Buffer.alloc(2);
    value.writeUInt16LE(epoch);
    return provider.Chain.setContractData(contract, `s:${address}`, `0x${value.toString('hex')}`, 'hex');
}
// Makes `address` a vouched moderator, vouched for by some other staker.
const seedVouched = (contract, address) => seedVouchers(contract, address, [randomAddress()]);
// Seeds vouches from `voucher` for `addresses`, as a staker would have made them.
async function seedVouches(contract, voucher, addresses) {
    await seedList(contract, `v:${voucher}`, addresses);
    for (const address of addresses) await seedVouchers(contract, address, [voucher]);
}

describe('release build: no identity has 1M stake', () => {
    let contract;
    let god;

    beforeEach(async () => {
        ({ contract, god } = await deploy('release'));
    });

    it('rejects transaction moderation by an address that is neither staked nor vouched', async () => {
        const hash = randomHash();

        let receipt = await call(contract, 'banTransaction', { hash });
        expect(receipt.success).toBe(true);
        expect(errorsOf(receipt)).toContainEqual(expect.stringContaining('only moderators can ban transactions'));
        expect(await isTransactionBanned(contract, hash)).toBe(false);

        receipt = await call(contract, 'banTransactions', { hashes: [hash, randomHash()] });
        expect(errorsOf(receipt)).toContainEqual(expect.stringContaining('only moderators can ban transactions'));
        expect(await isTransactionBanned(contract, hash)).toBe(false);

        await seedTransactionBan(contract, hash);
        receipt = await call(contract, 'unbanTransaction', { hash });
        expect(errorsOf(receipt)).toContainEqual(expect.stringContaining('only moderators can unban transactions'));
        expect(await isTransactionBanned(contract, hash)).toBe(true);

        // A failed stake check isn't remembered.
        expect(await readStakeEpoch(contract, god)).toBeNull();
    });

    it('rejects moderation by an address that is neither staked nor vouched', async () => {
        const target = randomAddress();

        let receipt = await call(contract, 'ban', { address: target });
        expect(receipt.success).toBe(true);
        expect(errorsOf(receipt)).toContainEqual(expect.stringContaining('only moderators can ban'));
        expect(eventsOf(receipt, 'ban')).toHaveLength(0);
        expect(await isBanned(contract, target)).toBe(false);

        await seedBan(contract, target, { permanent: true });
        receipt = await call(contract, 'unban', { address: target });
        expect(errorsOf(receipt)).toContainEqual(expect.stringContaining('only moderators can unban'));
        expect(await isBanned(contract, target)).toBe(true);
    });

    describe('as a vouched moderator', () => {
        beforeEach(async () => {
            await seedVouched(contract, god);
        });

        it('bans a non-moderator for a number of epochs', async () => {
            const target = randomAddress();

            const receipt = await call(contract, 'ban', { address: target, epochs: 3, reason: 'spam' });
            expect(errorsOf(receipt)).toEqual([]);

            const [args] = eventsOf(receipt, 'ban');
            expect(args[0]).toBe(target);
            expect(args[1]).toBe(god);
            expect(u16Of(args[2])).toBe(EPOCH);
            expect(u8Of(args[3])).toBe(0);
            expect(u32Of(args[4])).toBe(EPOCH + 3);
            expect(textOf(args[5])).toBe('spam');

            expect(await readMap(contract, 'b:', target)).toEqual({
                moderator: god,
                epoch: EPOCH,
                permanent: false,
                endEpoch: EPOCH + 3,
                reason: 'spam',
            });
            expect(await isBanned(contract, target)).toBe(true);
        });

        it('bans permanently when no epochs are given', async () => {
            const target = randomAddress();

            const receipt = await call(contract, 'ban', { address: target });
            expect(errorsOf(receipt)).toEqual([]);

            const ban = await readMap(contract, 'b:', target);
            expect(ban.permanent).toBe(true);
            expect(ban.reason).toBe('');
            expect(await isBanned(contract, target)).toBe(true);
        });

        it('accepts upper-case and unprefixed addresses', async () => {
            const target = randomAddress();

            const receipt = await call(contract, 'ban', { address: target.slice(2).toUpperCase() });
            expect(errorsOf(receipt)).toEqual([]);
            expect(await isBanned(contract, target)).toBe(true);
        });

        it('has enough gas by default for a maximum-length reason', async () => {
            const target = randomAddress();

            const receipt = await call(contract, 'ban', { address: target, reason: '漢'.repeat(93) });
            expect(errorsOf(receipt)).toEqual([]);
            expect(await isBanned(contract, target)).toBe(true);
        });

        it('bans and unbans a transaction', async () => {
            const hash = randomHash();

            let receipt = await call(contract, 'banTransaction', { hash, reason: 'spam' });
            expect(errorsOf(receipt)).toEqual([]);
            let [args] = eventsOf(receipt, 'banTransaction');
            expect(args[0]).toBe(hash);
            expect(args[1]).toBe(god);
            expect(u16Of(args[2])).toBe(EPOCH);
            expect(textOf(args[3])).toBe('spam');
            expect(await readMap(contract, 't:', hash)).toEqual({ moderator: god, epoch: EPOCH, reason: 'spam' });
            expect(await isTransactionBanned(contract, hash)).toBe(true);

            receipt = await call(contract, 'banTransaction', { hash });
            expect(receipt.success).toBe(false);
            expect(receipt.error).toContain('transaction is already banned');

            receipt = await call(contract, 'unbanTransaction', { hash, reason: 'not spam after all' });
            expect(errorsOf(receipt)).toEqual([]);
            [args] = eventsOf(receipt, 'unbanTransaction');
            expect(args[0]).toBe(hash);
            expect(args[1]).toBe(god);
            expect(textOf(args[2])).toBe('not spam after all');
            expect(await readMap(contract, 't:', hash)).toBeNull();
            expect(await isTransactionBanned(contract, hash)).toBe(false);

            receipt = await call(contract, 'unbanTransaction', { hash });
            expect(receipt.success).toBe(false);
            expect(receipt.error).toContain('transaction is not banned');
        });

        it('bans a batch of transactions, skipping ones already banned', async () => {
            const [ alreadyBanned, first, second ] = [randomHash(), randomHash(), randomHash()];
            await seedTransactionBan(contract, alreadyBanned);
            const earlierBan = await readMap(contract, 't:', alreadyBanned);

            const receipt = await call(contract, 'banTransactions', {
                hashes: [alreadyBanned, first, second.slice(2).toUpperCase(), first],
                reason: 'ban evasion',
            });
            expect(errorsOf(receipt)).toEqual([]);

            const events = eventsOf(receipt, 'banTransaction');
            expect(events.map((args) => args[0])).toEqual([first, second]);
            for (const args of events) {
                expect(args[1]).toBe(god);
                expect(textOf(args[3])).toBe('ban evasion');
            }
            expect(await readMap(contract, 't:', first)).toEqual({ moderator: god, epoch: EPOCH, reason: 'ban evasion' });
            expect(await isTransactionBanned(contract, second)).toBe(true);
            expect(await readMap(contract, 't:', alreadyBanned)).toEqual(earlierBan);
        });

        it('accepts upper-case and unprefixed transaction hashes', async () => {
            const hash = randomHash();

            const receipt = await call(contract, 'banTransaction', { hash: hash.slice(2).toUpperCase() });
            expect(errorsOf(receipt)).toEqual([]);
            expect(await isTransactionBanned(contract, hash)).toBe(true);
        });

        it('unbans, with or without a reason', async () => {
            const target = randomAddress();
            await call(contract, 'ban', { address: target });

            let receipt = await call(contract, 'unban', { address: target, reason: 'appeal accepted' });
            expect(errorsOf(receipt)).toEqual([]);

            const [args] = eventsOf(receipt, 'unban');
            expect(args[0]).toBe(target);
            expect(args[1]).toBe(god);
            expect(textOf(args[2])).toBe('appeal accepted');
            expect(await readMap(contract, 'b:', target)).toBeNull();
            expect(await isBanned(contract, target)).toBe(false);

            await call(contract, 'ban', { address: target });
            receipt = await call(contract, 'unban', { address: target });
            expect(errorsOf(receipt)).toEqual([]);
            expect(textOf(eventsOf(receipt, 'unban')[0][2])).toBe('');
        });

        it('rejects unbanning an address that is not banned', async () => {
            const receipt = await call(contract, 'unban', { address: randomAddress() });
            expect(receipt.success).toBe(false);
            expect(receipt.error).toContain('address is not banned');
        });

        it('treats an expired ban as lifted', async () => {
            const target = randomAddress();
            await seedBan(contract, target, { endEpoch: EPOCH });

            expect(await isBanned(contract, target)).toBe(false);
            const receipt = await call(contract, 'unban', { address: target });
            expect(receipt.error).toContain('address is not banned');
        });

        it('cannot ban a vouched moderator', async () => {
            const target = randomAddress();
            await seedVouched(contract, target);

            const receipt = await call(contract, 'ban', { address: target });
            expect(receipt.success).toBe(false);
            expect(receipt.error).toContain('cannot ban a moderator');
        });

        it('cannot vouch or revoke vouches', async () => {
            const target = randomAddress();

            let receipt = await call(contract, 'vouch', { address: target });
            expect(errorsOf(receipt)).toContainEqual(expect.stringContaining('only identities with 1M+ iDNA stake can vouch'));
            expect(await vouchCount(contract, target)).toBe(0);

            await seedVouched(contract, target);
            receipt = await call(contract, 'revokeVouches', { address: target });
            expect(errorsOf(receipt)).toContainEqual(
                expect.stringContaining('only identities with 1M+ iDNA stake can revoke vouches'),
            );
            expect(await vouchCount(contract, target)).toBe(1);
        });

        it('cannot moderate while banned, but can still withdraw vouches', async () => {
            const vouchee = randomAddress();
            await seedVouches(contract, god, [vouchee]);
            await seedBan(contract, god, { permanent: true });

            const calls = [
                ...['ban', 'unban', 'vouch', 'revokeVouches'].map((method) => [method, { address: randomAddress() }]),
                ...['banTransaction', 'unbanTransaction'].map((method) => [method, { hash: randomHash() }]),
                ['banTransactions', { hashes: [randomHash()] }],
            ];
            for (const [method, args] of calls) {
                const receipt = await call(contract, method, args);
                expect(receipt.success).toBe(false);
                expect(receipt.error).toContain('banned addresses cannot moderate');
            }

            const receipt = await call(contract, 'withdrawVouch', { address: vouchee });
            expect(errorsOf(receipt)).toEqual([]);
            expect(await vouchCount(contract, vouchee)).toBe(0);
        });

        it('can moderate again once its own ban expires', async () => {
            await seedBan(contract, god, { endEpoch: EPOCH });

            const receipt = await call(contract, 'ban', { address: randomAddress(), epochs: 1 });
            expect(errorsOf(receipt)).toEqual([]);
            expect(eventsOf(receipt, 'ban')).toHaveLength(1);
        });
    });

    describe('as a staker confirmed this epoch', () => {
        beforeEach(async () => {
            await seedStakeEpoch(contract, god);
        });

        it('moderates without looking itself up', async () => {
            const hash = randomHash();
            let receipt = await call(contract, 'banTransaction', { hash });
            expect(errorsOf(receipt)).toEqual([]);
            expect(identityLookupsOf(receipt)).toBe(0);
            expect(await isTransactionBanned(contract, hash)).toBe(true);

            receipt = await call(contract, 'unbanTransaction', { hash });
            expect(errorsOf(receipt)).toEqual([]);
            expect(identityLookupsOf(receipt)).toBe(0);
            expect(await isTransactionBanned(contract, hash)).toBe(false);

            const hashes = [randomHash(), randomHash()];
            receipt = await call(contract, 'banTransactions', { hashes });
            expect(errorsOf(receipt)).toEqual([]);
            expect(identityLookupsOf(receipt)).toBe(0);
            expect(await isTransactionBanned(contract, hashes[1])).toBe(true);

            // A ban still looks up its target, to check it isn't a staker.
            const target = randomAddress();
            receipt = await call(contract, 'ban', { address: target });
            expect(errorsOf(receipt)).toEqual([]);
            expect(identityLookupsOf(receipt)).toBe(1);
            expect(await isBanned(contract, target)).toBe(true);

            receipt = await call(contract, 'unban', { address: target });
            expect(errorsOf(receipt)).toEqual([]);
            expect(identityLookupsOf(receipt)).toBe(0);
            expect(await isBanned(contract, target)).toBe(false);
        });

        it('vouches and revokes vouches without looking itself up', async () => {
            const target = randomAddress();
            let receipt = await call(contract, 'vouch', { address: target });
            expect(errorsOf(receipt)).toEqual([]);
            expect(identityLookupsOf(receipt)).toBe(0);
            expect(u32Of(eventsOf(receipt, 'vouch')[0][2])).toBe(1);
            expect(await hasVouched(contract, god, target)).toBe(true);

            receipt = await call(contract, 'revokeVouches', { address: target });
            expect(errorsOf(receipt)).toEqual([]);
            expect(identityLookupsOf(receipt)).toBe(0);
            expect(u32Of(eventsOf(receipt, 'vouchesRevoked')[0][2])).toBe(1);
            expect(await vouchCount(contract, target)).toBe(0);
        });

        it('cannot be banned', async () => {
            const target = randomAddress();
            await seedStakeEpoch(contract, target);

            const receipt = await call(contract, 'ban', { address: target });
            expect(receipt.success).toBe(false);
            expect(receipt.error).toContain('cannot ban a moderator');
        });

        it('cannot moderate while banned', async () => {
            await seedBan(contract, god, { permanent: true });

            const receipt = await call(contract, 'banTransaction', { hash: randomHash() });
            expect(receipt.success).toBe(false);
            expect(receipt.error).toContain('banned addresses cannot moderate');
        });
    });

    it('looks up a staker confirmed in a different epoch again', async () => {
        // The runner stays in epoch 0, so a confirmation from any other epoch stands in for one that has expired.
        await seedStakeEpoch(contract, god, EPOCH + 1);
        const target = randomAddress();

        let receipt = await call(contract, 'banTransaction', { hash: randomHash() });
        expect(identityLookupsOf(receipt)).toBe(1);
        expect(errorsOf(receipt)).toContainEqual(expect.stringContaining('only moderators can ban transactions'));

        receipt = await call(contract, 'vouch', { address: target });
        expect(identityLookupsOf(receipt)).toBe(1);
        expect(errorsOf(receipt)).toContainEqual(expect.stringContaining('only identities with 1M+ iDNA stake can vouch'));
        expect(await vouchCount(contract, target)).toBe(0);
    });

    describe('reports', () => {
        it('lets anyone report an address, without storing anything', async () => {
            const target = randomAddress();

            const receipt = await call(contract, 'report', { address: target, reason: 'impersonation' });
            expect(errorsOf(receipt)).toEqual([]);
            const [args] = eventsOf(receipt, 'report');
            expect(args[0]).toBe(target);
            expect(args[1]).toBe(god);
            expect(textOf(args[2])).toBe('impersonation');
            expect(await isBanned(contract, target)).toBe(false);
        });

        it('lets anyone report a transaction', async () => {
            const hash = randomHash();

            const receipt = await call(contract, 'reportTransaction', { hash, reason: '漢'.repeat(93) });
            expect(errorsOf(receipt)).toEqual([]);
            const [args] = eventsOf(receipt, 'reportTransaction');
            expect(args[0]).toBe(hash);
            expect(args[1]).toBe(god);
            expect(textOf(args[2])).toBe('漢'.repeat(93));
            expect(await isTransactionBanned(contract, hash)).toBe(false);
        });

        it('needs a reason and a valid target', async () => {
            const cases = [
                ['report', { address: randomAddress() }, 'reason is required'],
                ['report', { address: randomAddress(), reason: 'x'.repeat(281) }, 'reason is too long'],
                ['report', { address: '0x1234', reason: 'spam' }, 'invalid address'],
                ['report', { address: god, reason: 'spam' }, 'cannot report yourself'],
                ['reportTransaction', { hash: randomHash() }, 'reason is required'],
                ['reportTransaction', { hash: randomHash(), reason: 'x'.repeat(281) }, 'reason is too long'],
                ['reportTransaction', { hash: randomAddress(), reason: 'spam' }, 'invalid transaction hash'],
            ];
            for (const [method, args, error] of cases) {
                const receipt = await call(contract, method, args);
                expect(receipt.success).toBe(false);
                expect(receipt.error).toContain(error);
            }
        });

        it("doesn't let a banned address report", async () => {
            await seedBan(contract, god, { permanent: true });

            let receipt = await call(contract, 'report', { address: randomAddress(), reason: 'spam' });
            expect(receipt.success).toBe(false);
            expect(receipt.error).toContain('banned addresses cannot report');

            receipt = await call(contract, 'reportTransaction', { hash: randomHash(), reason: 'spam' });
            expect(receipt.success).toBe(false);
            expect(receipt.error).toContain('banned addresses cannot report');
        });
    });

    it('validates input', async () => {
        await seedVouched(contract, god);
        const banned = randomAddress();
        await seedBan(contract, banned, { permanent: true });
        const cases = [
            ['ban', { address: '0x1234' }, 'invalid address'],
            ['ban', { address: `0x${'zz'.repeat(20)}` }, 'invalid address'],
            ['ban', { address: god }, 'cannot ban yourself'],
            ['vouch', { address: god }, 'cannot vouch for yourself'],
            ['vouch', { address: banned }, 'cannot vouch for a banned address'],
            ['ban', { address: randomAddress(), epochs: 65_536 }, 'ban is too long'],
            ['ban', { address: randomAddress(), reason: 'x'.repeat(281) }, 'reason is too long'],
            // The limit is in UTF-8 bytes: 94 three-byte characters are 282 bytes.
            ['ban', { address: randomAddress(), reason: '漢'.repeat(94) }, 'reason is too long'],
            ['withdrawVouch', { address: randomAddress() }, 'no vouch to withdraw'],
            ['revokeVouches', { address: randomAddress() }, 'address has no vouches'],
            ['banTransaction', { hash: '0x1234' }, 'invalid transaction hash'],
            ['banTransaction', { hash: `0x${'zz'.repeat(32)}` }, 'invalid transaction hash'],
            ['banTransaction', { hash: randomHash(), reason: 'x'.repeat(281) }, 'reason is too long'],
            ['unban', { address: randomAddress(), reason: 'x'.repeat(281) }, 'reason is too long'],
            ['unbanTransaction', { hash: randomHash(), reason: 'x'.repeat(281) }, 'reason is too long'],
            ['unbanTransaction', { hash: randomAddress() }, 'invalid transaction hash'],
            ['banTransactions', { hashes: [] }, 'no transactions to ban'],
            ['banTransactions', { hashes: Array.from({ length: 101 }, randomHash) }, 'too many transactions'],
            ['banTransactions', { hashes: [randomHash()], reason: 'x'.repeat(281) }, 'reason is too long'],
        ];
        for (const [method, args, error] of cases) {
            const receipt = await call(contract, method, args);
            expect(receipt.success).toBe(false);
            expect(receipt.error).toContain(error);
        }
    });

    it('bans nothing when any hash in a batch is invalid', async () => {
        await seedVouched(contract, god);
        const valid = randomHash();

        const receipt = await call(contract, 'banTransactions', { hashes: [valid, '0x1234'] });
        expect(receipt.success).toBe(false);
        expect(receipt.error).toContain('invalid transaction hash');
        expect(await isTransactionBanned(contract, valid)).toBe(false);
    });

    it('rejects direct calls to callbacks', async () => {
        const target = randomAddress();

        const receipt = await send(contract, '_vouchAsStaker', [
            { index: 0, format: ContractArgumentFormat.Hex, value: god },
            { index: 1, format: ContractArgumentFormat.Hex, value: target },
        ]);
        // The VM refuses '_' methods outside a callback; @privateMethod is a second guard behind it.
        expect(receipt.success).toBe(false);
        expect(receipt.error).toContain('direct call to promise callback is forbidden');
        expect(await vouchCount(contract, target)).toBe(0);
    });

    it('keeps no fields in the contract class', async () => {
        // Every call and callback loads and parses the class's fields, so the maps are module constants instead.
        expect(await provider.Contract.readData(contract, 'STATE', 'string')).toBe('{}');
    });
});

describe('test build: every identity counts as a 1M+ staker', () => {
    let contract;
    let god;

    beforeEach(async () => {
        ({ contract, god } = await deploy('test'));
    });

    it('vouches and withdraws the vouch', async () => {
        const target = randomAddress();

        let receipt = await call(contract, 'vouch', { address: target });
        expect(errorsOf(receipt)).toEqual([]);
        let [args] = eventsOf(receipt, 'vouch');
        expect(args[0]).toBe(target);
        expect(args[1]).toBe(god);
        expect(u32Of(args[2])).toBe(1);
        expect(await vouchCount(contract, target)).toBe(1);
        expect(await hasVouched(contract, god, target)).toBe(true);

        receipt = await call(contract, 'vouch', { address: target });
        expect(receipt.success).toBe(false);
        expect(receipt.error).toContain('already vouched');

        receipt = await call(contract, 'withdrawVouch', { address: target });
        expect(errorsOf(receipt)).toEqual([]);
        [args] = eventsOf(receipt, 'vouchWithdrawn');
        expect(args[0]).toBe(target);
        expect(args[1]).toBe(god);
        expect(u32Of(args[2])).toBe(0);
        expect(await vouchCount(contract, target)).toBe(0);
        expect(await hasVouched(contract, god, target)).toBe(false);
        expect(await readList(contract, 'm:', target)).toBeNull();
        expect(await readList(contract, 'v:', god)).toBeNull();
    });

    it('looks a staker up once per epoch', async () => {
        let receipt = await call(contract, 'banTransaction', { hash: randomHash() });
        expect(errorsOf(receipt)).toEqual([]);
        expect(identityLookupsOf(receipt)).toBe(1);
        expect(await readStakeEpoch(contract, god)).toBe(EPOCH);

        receipt = await call(contract, 'banTransaction', { hash: randomHash() });
        expect(errorsOf(receipt)).toEqual([]);
        expect(identityLookupsOf(receipt)).toBe(0);

        receipt = await call(contract, 'vouch', { address: randomAddress() });
        expect(errorsOf(receipt)).toEqual([]);
        expect(identityLookupsOf(receipt)).toBe(0);
    });

    it('lists who vouched for an address', async () => {
        const target = randomAddress();
        const other = randomAddress();
        await seedVouchers(contract, target, [other]);

        const receipt = await call(contract, 'vouch', { address: target });
        expect(errorsOf(receipt)).toEqual([]);
        expect(u32Of(eventsOf(receipt, 'vouch')[0][2])).toBe(2);
        expect(await readList(contract, 'm:', target)).toEqual([other, god]);

        await call(contract, 'withdrawVouch', { address: target });
        expect(await readList(contract, 'm:', target)).toEqual([other]);
    });

    it('bans and unbans a transaction without being vouched', async () => {
        const hash = randomHash();

        // A maximum-length reason also checks the default gas covers the callback.
        let receipt = await call(contract, 'banTransaction', { hash, reason: '漢'.repeat(93) });
        expect(errorsOf(receipt)).toEqual([]);
        expect((await readMap(contract, 't:', hash)).reason).toBe('漢'.repeat(93));

        receipt = await call(contract, 'unbanTransaction', { hash, reason: '漢'.repeat(93) });
        expect(errorsOf(receipt)).toEqual([]);
        expect(textOf(eventsOf(receipt, 'unbanTransaction')[0][2])).toBe('漢'.repeat(93));
        expect(await isTransactionBanned(contract, hash)).toBe(false);
    });

    it('bans a full batch with maximum-length reasons on the default gas', async () => {
        const hashes = Array.from({ length: 100 }, randomHash);

        // The automatic callback reservation (204M wasm gas) needs a higher max fee than the tests' default.
        const receipt = await call(contract, 'banTransactions', { hashes, reason: '漢'.repeat(93) }, '0', '30000');
        expect(errorsOf(receipt)).toEqual([]);
        expect(eventsOf(receipt, 'banTransaction')).toHaveLength(100);
        expect(await isTransactionBanned(contract, hashes[0])).toBe(true);
        expect(await isTransactionBanned(contract, hashes[99])).toBe(true);
    });

    it('unbans without being vouched', async () => {
        const target = randomAddress();
        await seedBan(contract, target, { permanent: true });

        const receipt = await call(contract, 'unban', { address: target, reason: 'appeal accepted' });
        expect(errorsOf(receipt)).toEqual([]);
        expect(textOf(eventsOf(receipt, 'unban')[0][2])).toBe('appeal accepted');
        expect(await isBanned(contract, target)).toBe(false);
    });

    it('cannot ban a staker', async () => {
        const target = randomAddress();

        const receipt = await call(contract, 'ban', { address: target });
        expect(errorsOf(receipt)).toContainEqual(expect.stringContaining('cannot ban a moderator'));
        expect(eventsOf(receipt, 'ban')).toHaveLength(0);
        expect(await isBanned(contract, target)).toBe(false);
    });

    it('limits a staker to 5 vouches in effect', async () => {
        const [a, b, c, d, e, f, g] = Array.from({ length: 7 }, randomAddress);
        for (const address of [a, b, c, d, e]) {
            expect(errorsOf(await call(contract, 'vouch', { address }))).toEqual([]);
        }

        let receipt = await call(contract, 'vouch', { address: f });
        expect(receipt.success).toBe(false);
        expect(receipt.error).toContain('vouch limit reached');

        // Withdrawing a vouch frees its slot.
        await call(contract, 'withdrawVouch', { address: a });
        receipt = await call(contract, 'vouch', { address: f });
        expect(errorsOf(receipt)).toEqual([]);

        // So does another staker revoking it.
        await call(contract, 'revokeVouches', { address: b });
        expect(await hasVouched(contract, god, b)).toBe(false);
        receipt = await call(contract, 'vouch', { address: g });
        expect(errorsOf(receipt)).toEqual([]);

        expect(await readList(contract, 'v:', god)).toEqual([c, d, e, f, g]);
        expect(await readList(contract, 'm:', a)).toBeNull();
        expect(await readList(contract, 'm:', b)).toBeNull();
    });

    it('has enough gas by default to vouch with a full list for an address with 45 vouchers', async () => {
        // Only the target's own voucher list is read in full, so that's the one that's made long. The other stakers'
        // vouch records don't matter here, so only their list entries are seeded.
        const othersVouchers = () => Array.from({ length: 45 }, randomAddress);
        const vouchees = Array.from({ length: 4 }, randomAddress);
        await seedList(contract, `v:${god}`, vouchees);
        for (const vouchee of vouchees) {
            await seedList(contract, `m:${vouchee}`, [god, ...othersVouchers()]);
            await seedVouchRecord(contract, vouchee, god);
        }
        const target = randomAddress();
        await seedList(contract, `m:${target}`, othersVouchers());

        const receipt = await call(contract, 'vouch', { address: target });
        expect(errorsOf(receipt)).toEqual([]);
        expect(await readList(contract, 'v:', god)).toHaveLength(5);
    });

    it('revokes every vouch for an address', async () => {
        const target = randomAddress();
        const [voucherA, voucherB] = [randomAddress(), randomAddress()];
        await seedList(contract, `v:${voucherA}`, [target]);
        await seedList(contract, `v:${voucherB}`, [target]);
        await seedVouchers(contract, target, [voucherA, voucherB]);
        expect(await hasVouched(contract, voucherA, target)).toBe(true);
        expect(await readList(contract, 'm:', target)).toEqual([voucherA, voucherB]);

        let receipt = await call(contract, 'revokeVouches', { address: target });
        expect(errorsOf(receipt)).toEqual([]);
        const [args] = eventsOf(receipt, 'vouchesRevoked');
        expect(args[0]).toBe(target);
        expect(args[1]).toBe(god);
        expect(u32Of(args[2])).toBe(2);

        expect(await vouchCount(contract, target)).toBe(0);
        expect(await hasVouched(contract, voucherA, target)).toBe(false);
        expect(await hasVouched(contract, voucherB, target)).toBe(false);
        expect(await readList(contract, 'm:', target)).toBeNull();

        receipt = await call(contract, 'revokeVouches', { address: target });
        expect(receipt.error).toContain('address has no vouches');

        // Vouching starts again from a clean slate.
        receipt = await call(contract, 'vouch', { address: target });
        expect(errorsOf(receipt)).toEqual([]);
        expect(await vouchCount(contract, target)).toBe(1);
        expect(await hasVouched(contract, god, target)).toBe(true);
    });
});
