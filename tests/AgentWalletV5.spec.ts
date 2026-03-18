import { compile } from '@ton/blueprint';
import {
    Cell,
    toNano,
    internal as internal_relaxed,
    beginCell,
    SendMode,
    ExternalAddress,
    Address
} from '@ton/core';
import '@ton/test-utils';
import {
    Blockchain,
    printTransactionFees,
    SandboxContract,
    TreasuryContract
} from '@ton/sandbox';
import { KeyPair, getSecureRandomBytes, keyPairFromSeed } from '@ton/crypto';
import { AgentWalletV5, Opcodes } from '../wrappers/AgentWalletV5';
import {
    AgentWalletV5Test,
    MessageOut,
    WalletActions,
    message2action
} from '../wrappers/AgentWalletV5TestHelpers';
import { ErrorsV5 } from '../wrappers/Errors';
import { bufferToBigInt, getRandomInt } from './utils';
import { findTransactionRequired } from '@ton/test-utils';

describe('AgentWalletV5', () => {
    let blockchain: Blockchain;
    let keys: KeyPair;
    let wallet: SandboxContract<AgentWalletV5Test>;
    let walletId: number;
    let owner: SandboxContract<TreasuryContract>;
    let testReceiver: SandboxContract<TreasuryContract>;
    let code: Cell;

    const defaultExternalMode = SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS;

    let mockMessage: MessageOut;

    const curTime = () => blockchain.now ?? Math.floor(Date.now() / 1000);

    beforeAll(async () => {
        code = await compile('AgentWalletV5');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        keys = keyPairFromSeed(await getSecureRandomBytes(32));

        owner = await blockchain.treasury('owner');
        testReceiver = await blockchain.treasury('receiver');

        walletId = getRandomInt(10, 1337);

        wallet = blockchain.openContract(
            AgentWalletV5Test.createFromConfig(
                {
                    signatureAllowed: true,
                    seqno: 0,
                    walletId,
                    publicKey: keys.publicKey,
                    ownerAddress: owner.address
                },
                code
            )
        );

        const deploy = await owner.send({
            to: wallet.address,
            value: toNano('10000'),
            init: wallet.init
        });

        expect(deploy.transactions).toHaveTransaction({
            on: wallet.address,
            from: owner.address,
            aborted: false,
            deploy: true
        });

        mockMessage = {
            message: internal_relaxed({
                to: testReceiver.address,
                value: toNano('1'),
                body: beginCell().storeUint(0xdeadbeef, 32).endCell()
            }),
            mode: defaultExternalMode
        };
    });

    describe('Deployment & basic', () => {
        it('should deploy correctly', async () => {
            const seqno = await wallet.getSeqno();
            expect(seqno).toBe(0);

            const subwalletId = await wallet.getSubwalletId();
            expect(subwalletId).toBe(walletId);

            const publicKey = await wallet.getPublicKey();
            expect(publicKey).toBe(bufferToBigInt(keys.publicKey));

            const sigAllowed = await wallet.getIsSignatureAllowed();
            expect(sigAllowed).toBe(true);
        });

        it('should receive TON without body', async () => {
            const sender = await blockchain.treasury('random_sender');
            const res = await sender.send({
                to: wallet.address,
                value: toNano('5'),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });
            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: sender.address,
                aborted: false,
                outMessagesCount: 0
            });
        });

        it('should receive TON with text comment', async () => {
            const sender = await blockchain.treasury('random_sender');
            const res = await sender.send({
                to: wallet.address,
                value: toNano('5'),
                body: beginCell().storeUint(0, 32).storeStringTail('Hello').endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });
            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: sender.address,
                aborted: false,
                outMessagesCount: 0
            });
        });

        it('should receive TON with unknown opcode', async () => {
            const sender = await blockchain.treasury('random_sender');
            const unknownOp = 0x12345678;
            const res = await sender.send({
                to: wallet.address,
                value: toNano('5'),
                body: beginCell().storeUint(unknownOp, 32).storeUint(0, 64).endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });
            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: sender.address,
                aborted: false,
                outMessagesCount: 0
            });
        });
    });

    describe('External signed messages', () => {
        it('should send message to arbitrary address', async () => {
            const seqNo = await wallet.getSeqno();
            const res = await wallet.sendMessagesExternal(
                walletId,
                curTime() + 1000,
                seqNo,
                keys.secretKey,
                [mockMessage]
            );

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                op: Opcodes.auth_signed,
                aborted: false,
                outMessagesCount: 1
            });
            expect(res.transactions).toHaveTransaction({
                on: testReceiver.address,
                from: wallet.address,
                value: toNano('1')
            });
            expect(await wallet.getSeqno()).toBe(seqNo + 1);
        });

        it('should reject wrong signature', async () => {
            const seqNo = await wallet.getSeqno();
            const badKeys = keyPairFromSeed(await getSecureRandomBytes(32));

            await expect(
                wallet.sendMessagesExternal(
                    walletId,
                    curTime() + 1000,
                    seqNo,
                    badKeys.secretKey,
                    [mockMessage]
                )
            ).rejects.toThrow();

            expect(await wallet.getSeqno()).toBe(seqNo);
        });

        it('should reject non-signed_external prefix', async () => {
            const seqNo = await wallet.getSeqno();
            const validMsg = AgentWalletV5Test.requestMessage(
                false,
                walletId,
                curTime() + 1000,
                seqNo,
                {}
            );
            const msgTail = validMsg.beginParse().skip(32);

            // Try with signed_internal prefix
            const badMsg = AgentWalletV5Test.signRequestMessage(
                beginCell().storeUint(Opcodes.auth_signed_internal, 32).storeSlice(msgTail).endCell(),
                keys.secretKey
            );

            await expect(wallet.sendRawExternal(badMsg)).rejects.toThrow();
            expect(await wallet.getSeqno()).toBe(seqNo);
        });

        it('should send up to 255 messages', async () => {
            const seqNo = await wallet.getSeqno();
            const messages: MessageOut[] = [];
            for (let i = 0; i < 255; i++) {
                messages.push({
                    message: internal_relaxed({
                        to: testReceiver.address,
                        value: toNano('1'),
                        body: beginCell().storeUint(i, 32).endCell()
                    }),
                    mode: defaultExternalMode
                });
            }

            const res = await wallet.sendMessagesExternal(
                walletId,
                curTime() + 1000,
                seqNo,
                keys.secretKey,
                messages
            );

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                op: Opcodes.auth_signed,
                aborted: false,
                outMessagesCount: 255
            });
            expect(await wallet.getSeqno()).toBe(seqNo + 1);
        });

        it('should accept send modes with IGNORE_ERRORS', async () => {
            const seqNo = await wallet.getSeqno();
            const modes = [
                SendMode.NONE | SendMode.IGNORE_ERRORS,
                SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
                SendMode.CARRY_ALL_REMAINING_BALANCE | SendMode.IGNORE_ERRORS
            ];

            for (let i = 0; i < modes.length; i++) {
                const msg: MessageOut = {
                    message: internal_relaxed({
                        to: testReceiver.address,
                        value: toNano('1'),
                        body: beginCell().storeUint(i, 32).endCell()
                    }),
                    mode: modes[i]
                };

                const res = await wallet.sendMessagesExternal(
                    walletId,
                    curTime() + 1000,
                    seqNo + i,
                    keys.secretKey,
                    [msg]
                );

                expect(res.transactions).toHaveTransaction({
                    on: wallet.address,
                    op: Opcodes.auth_signed,
                    aborted: false
                });
            }
        });

        it('should reject send modes without IGNORE_ERRORS for external', async () => {
            const seqNo = await wallet.getSeqno();

            const msg: MessageOut = {
                message: internal_relaxed({
                    to: testReceiver.address,
                    value: toNano('1'),
                    body: beginCell().storeUint(0, 32).endCell()
                }),
                mode: SendMode.PAY_GAS_SEPARATELY // no IGNORE_ERRORS
            };

            // External sends commit seqno before processing actions, so the tx
            // succeeds (exitCode shown in compute phase) but actions fail.
            // The seqno still increments because of commit().
            const reqMsg = AgentWalletV5Test.requestMessage(
                false,
                walletId,
                curTime() + 1000,
                seqNo,
                { wallet: [message2action(msg)] },
                keys.secretKey
            );
            const res = await wallet.sendRawExternal(reqMsg);
            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                op: Opcodes.auth_signed,
                exitCode: ErrorsV5.external_send_message_must_have_ignore_errors_send_mode
            });
            // Seqno still incremented due to commit()
            expect(await wallet.getSeqno()).toBe(seqNo + 1);
        });

        it('should send external-out message', async () => {
            const seqNo = await wallet.getSeqno();
            const testPayload = BigInt(getRandomInt(0, 100000));
            const testBody = beginCell().storeUint(testPayload, 32).endCell();

            const res = await wallet.sendMessagesExternal(
                walletId,
                curTime() + 100,
                seqNo,
                keys.secretKey,
                [
                    {
                        message: {
                            info: {
                                type: 'external-out',
                                createdAt: 0,
                                createdLt: 0n,
                                dest: new ExternalAddress(testPayload, 32),
                                src: null
                            },
                            body: testBody
                        },
                        mode: defaultExternalMode
                    }
                ]
            );

            const txSuccess = findTransactionRequired(res.transactions, {
                on: wallet.address,
                op: Opcodes.auth_signed,
                aborted: false
            });

            expect(txSuccess.externals.length).toBe(1);
            expect(txSuccess.externals[0].info.dest!.value).toBe(testPayload);
            expect(txSuccess.externals[0].body).toEqualCell(testBody);
        });

        it('should reject invalid seqno', async () => {
            const seqNo = await wallet.getSeqno();

            for (const testSeq of [seqNo + 1, seqNo + 10]) {
                await expect(
                    wallet.sendMessagesExternal(
                        walletId,
                        curTime() + 100,
                        testSeq,
                        keys.secretKey,
                        [mockMessage]
                    )
                ).rejects.toThrow();
                expect(await wallet.getSeqno()).toBe(seqNo);
            }
        });

        it('should reject invalid wallet id', async () => {
            const seqNo = await wallet.getSeqno();

            for (const testId of [walletId + 1, walletId - 1, walletId + 100]) {
                await expect(
                    wallet.sendMessagesExternal(
                        testId,
                        curTime() + 100,
                        seqNo,
                        keys.secretKey,
                        [mockMessage]
                    )
                ).rejects.toThrow();
                expect(await wallet.getSeqno()).toBe(seqNo);
            }
        });

        it('should reject expired message', async () => {
            blockchain.now = curTime();
            const seqNo = await wallet.getSeqno();

            // valid_until <= now() is expired
            for (const testUntil of [blockchain.now, blockchain.now - 100]) {
                await expect(
                    wallet.sendMessagesExternal(
                        walletId,
                        testUntil,
                        seqNo,
                        keys.secretKey,
                        [mockMessage]
                    )
                ).rejects.toThrow();
                expect(await wallet.getSeqno()).toBe(seqNo);
            }

            // valid_until > now() should work
            const res = await wallet.sendMessagesExternal(
                walletId,
                blockchain.now + 1,
                seqNo,
                keys.secretKey,
                [mockMessage]
            );
            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                op: Opcodes.auth_signed,
                aborted: false
            });
            expect(await wallet.getSeqno()).toBe(seqNo + 1);
        });

        it('should reject set_code action (exit code 9, but seqno committed)', async () => {
            const seqNo = await wallet.getSeqno();

            // Build a raw action cell with action_set_code prefix to test rejection
            // Construct actions with a setCode action
            const actions: WalletActions = {
                wallet: beginCell()
                    .store(
                        // Build a fake action list with action_set_code
                        (builder) => {
                            builder.storeUint(0xad4de08e, 32); // action_set_code prefix
                            builder.storeUint(8, 8); // some mode bits
                            builder.storeRef(beginCell().storeUint(123, 32).endCell()); // new code
                            builder.storeRef(beginCell().endCell()); // next action ref (empty)
                        }
                    )
                    .endCell()
            };

            const reqMsg = AgentWalletV5Test.requestMessage(
                false,
                walletId,
                curTime() + 1000,
                seqNo,
                actions,
                keys.secretKey
            );
            const res = await wallet.sendRawExternal(reqMsg);

            // set_code will cause exit code 9 in action phase, but seqno committed
            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                op: Opcodes.auth_signed,
                exitCode: 9
            });
            expect(await wallet.getSeqno()).toBe(seqNo + 1);
        });

        it('empty action list should increase seqno', async () => {
            const seqNo = await wallet.getSeqno();
            const reqMsg = AgentWalletV5Test.requestMessage(
                false,
                walletId,
                curTime() + 100,
                seqNo,
                {},
                keys.secretKey
            );
            const res = await wallet.sendRawExternal(reqMsg);

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                op: Opcodes.auth_signed,
                aborted: false
            });
            expect(await wallet.getSeqno()).toBe(seqNo + 1);
        });
    });

    describe('Internal messages (signed_internal not supported)', () => {
        it('should silently accept internal signed message without processing', async () => {
            // The contract recv_internal does NOT handle signed_internal prefix.
            // Messages with signed_internal opcode are treated as regular TON transfers.
            const seqNo = await wallet.getSeqno();
            const res = await wallet.sendMessagesInternal(
                owner.getSender(),
                walletId,
                curTime() + 1000,
                seqNo,
                keys.secretKey,
                [mockMessage]
            );

            // Message is silently accepted, no actions processed
            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                aborted: false,
                outMessagesCount: 0
            });
            // Seqno should NOT change
            expect(await wallet.getSeqno()).toBe(seqNo);
        });

        it('should silently accept internal signed message from anyone', async () => {
            const seqNo = await wallet.getSeqno();
            const randomSender = await blockchain.treasury('random_sender');

            const res = await wallet.sendMessagesInternal(
                randomSender.getSender(),
                walletId,
                curTime() + 1000,
                seqNo,
                keys.secretKey,
                [mockMessage]
            );

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                aborted: false,
                outMessagesCount: 0
            });
            expect(await wallet.getSeqno()).toBe(seqNo);
        });
    });

    describe('Signature disabled', () => {
        it('should reject external when signature disabled', async () => {
            const disabledWallet = blockchain.openContract(
                AgentWalletV5Test.createFromConfig(
                    {
                        signatureAllowed: false,
                        seqno: 0,
                        walletId,
                        publicKey: keys.publicKey,
                        ownerAddress: owner.address
                    },
                    code
                )
            );

            await owner.send({
                to: disabledWallet.address,
                value: toNano('1000'),
                init: disabledWallet.init
            });

            await expect(
                disabledWallet.sendMessagesExternal(
                    walletId,
                    curTime() + 1000,
                    0,
                    keys.secretKey,
                    [mockMessage]
                )
            ).rejects.toThrow();

            expect(await disabledWallet.getSeqno()).toBe(0);
        });

        it('should silently accept internal signed when signature disabled (not processed)', async () => {
            // signed_internal is not handled by recv_internal, so it's just accepted as TON
            const disabledWallet = blockchain.openContract(
                AgentWalletV5Test.createFromConfig(
                    {
                        signatureAllowed: false,
                        seqno: 0,
                        walletId,
                        publicKey: keys.publicKey,
                        ownerAddress: owner.address
                    },
                    code
                )
            );

            await owner.send({
                to: disabledWallet.address,
                value: toNano('1000'),
                init: disabledWallet.init
            });

            const res = await disabledWallet.sendMessagesInternal(
                owner.getSender(),
                walletId,
                curTime() + 1000,
                0,
                keys.secretKey,
                [mockMessage]
            );

            // Internal signed messages are silently ignored (treated as TON transfer)
            expect(res.transactions).toHaveTransaction({
                on: disabledWallet.address,
                aborted: false,
                outMessagesCount: 0
            });
            expect(await disabledWallet.getSeqno()).toBe(0);
        });
    });

    describe('Get methods', () => {
        it('should return correct seqno', async () => {
            expect(await wallet.getSeqno()).toBe(0);

            await wallet.sendMessagesExternal(
                walletId,
                curTime() + 1000,
                0,
                keys.secretKey,
                [mockMessage]
            );

            expect(await wallet.getSeqno()).toBe(1);
        });

        it('should return correct subwallet id', async () => {
            expect(await wallet.getSubwalletId()).toBe(walletId);
        });

        it('should return correct public key', async () => {
            expect(await wallet.getPublicKey()).toBe(bufferToBigInt(keys.publicKey));
        });

        it('should return correct is_signature_allowed', async () => {
            expect(await wallet.getIsSignatureAllowed()).toBe(true);
        });

        it('should return correct hash_prompt', async () => {
            const hashPrompt = 123456789n;
            const walletWithPrompt = blockchain.openContract(
                AgentWalletV5Test.createFromConfig(
                    {
                        signatureAllowed: true,
                        seqno: 0,
                        walletId,
                        publicKey: keys.publicKey,
                        ownerAddress: owner.address,
                        hashPrompt
                    },
                    code
                )
            );

            await owner.send({
                to: walletWithPrompt.address,
                value: toNano('1'),
                init: walletWithPrompt.init
            });

            expect(await walletWithPrompt.getHashPrompt()).toBe(hashPrompt);
        });
    });

    describe('Bounced messages', () => {
        it('should ignore bounced messages with recognized op', async () => {
            // Build a bounced internal message manually with the bounced flag set
            const bouncedBody = beginCell()
                .storeUint(Opcodes.withdraw_ton, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(owner.address)
                .endCell();

            const bouncedMsg = beginCell()
                .storeUint(0, 1)       // int_msg_info tag
                .storeBit(true)        // ihr_disabled
                .storeBit(false)       // bounce
                .storeBit(true)        // bounced = true
                .storeAddress(owner.address)  // src
                .storeAddress(wallet.address) // dest
                .storeCoins(toNano('1'))      // value
                .storeBit(false)       // no extra currencies
                .storeCoins(0)         // ihr_fee
                .storeCoins(0)         // fwd_fee
                .storeUint(0, 64)      // created_lt
                .storeUint(0, 32)      // created_at
                .storeBit(false)       // no init
                .storeBit(true)        // body in ref
                .storeRef(bouncedBody)
                .endCell();

            const res = await blockchain.sendMessage(bouncedMsg);

            // Should silently accept (not abort), no outgoing messages
            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                aborted: false,
                outMessagesCount: 0
            });
        });
    });

    describe('Topup action', () => {
        it('should accept topup from owner', async () => {
            const res = await owner.send({
                to: wallet.address,
                value: toNano('100'),
                body: beginCell()
                    .storeUint(Opcodes.topup_action, 32)
                    .storeUint(0, 64)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: owner.address,
                aborted: false
            });
        });

        it('should reject topup from non-owner', async () => {
            const stranger = await blockchain.treasury('stranger');
            const res = await stranger.send({
                to: wallet.address,
                value: toNano('100'),
                body: beginCell()
                    .storeUint(Opcodes.topup_action, 32)
                    .storeUint(0, 64)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: stranger.address,
                aborted: true,
                exitCode: ErrorsV5.invalid_message_operation
            });
        });
    });

    describe('withdraw_ton', () => {
        it('should withdraw TON to specified address when called by owner', async () => {
            const seqnoBefore = await wallet.getSeqno();

            const body = beginCell()
                .storeUint(Opcodes.withdraw_ton, 32)
                .storeUint(0, 64) // query_id
                .storeCoins(toNano('5'))
                .storeAddress(testReceiver.address)
                .endCell();

            const res = await owner.send({
                to: wallet.address,
                value: toNano('0.5'),
                body,
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: owner.address,
                op: Opcodes.withdraw_ton,
                aborted: false,
                outMessagesCount: 1
            });

            expect(res.transactions).toHaveTransaction({
                on: testReceiver.address,
                from: wallet.address,
                value: toNano('5')
            });

            // seqno should not change
            expect(await wallet.getSeqno()).toBe(seqnoBefore);
        });

        it('should reject withdraw_ton from non-owner', async () => {
            const stranger = await blockchain.treasury('stranger');

            const body = beginCell()
                .storeUint(Opcodes.withdraw_ton, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(testReceiver.address)
                .endCell();

            const res = await stranger.send({
                to: wallet.address,
                value: toNano('0.5'),
                body,
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: stranger.address,
                aborted: true,
                exitCode: ErrorsV5.invalid_message_operation
            });
        });
    });

    describe('withdraw_jetton', () => {
        it('should withdraw jettons when called by owner', async () => {
            const seqnoBefore = await wallet.getSeqno();

            const jettonPayload = AgentWalletV5.buildJettonTransferPayload({
                queryId: 0n,
                jettonAmount: toNano('100'),
                toAddress: owner.address,
                responseAddress: owner.address,
                forwardTonAmount: toNano('0.01')
            });

            const body = beginCell()
                .storeUint(Opcodes.withdraw_jetton, 32)
                .storeUint(0, 64) // query_id
                .storeCoins(toNano('0.1')) // ton_amount to attach
                .storeAddress(testReceiver.address) // jetton wallet address
                .storeRef(jettonPayload)
                .endCell();

            const res = await owner.send({
                to: wallet.address,
                value: toNano('0.5'),
                body,
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: owner.address,
                op: Opcodes.withdraw_jetton,
                aborted: false,
                outMessagesCount: 1
            });

            expect(res.transactions).toHaveTransaction({
                on: testReceiver.address,
                from: wallet.address,
                value: toNano('0.1'),
                op: Opcodes.jetton_transfer
            });

            expect(await wallet.getSeqno()).toBe(seqnoBefore);
        });

        it('should reject withdraw_jetton from non-owner', async () => {
            const stranger = await blockchain.treasury('stranger');

            const jettonPayload = AgentWalletV5.buildJettonTransferPayload({
                jettonAmount: toNano('100'),
                toAddress: owner.address,
                responseAddress: owner.address
            });

            const body = beginCell()
                .storeUint(Opcodes.withdraw_jetton, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('0.1'))
                .storeAddress(testReceiver.address)
                .storeRef(jettonPayload)
                .endCell();

            const res = await stranger.send({
                to: wallet.address,
                value: toNano('0.5'),
                body,
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: stranger.address,
                aborted: true,
                exitCode: ErrorsV5.invalid_message_operation
            });
        });

        it('should reject withdraw_jetton with invalid op in payload', async () => {
            // Payload with wrong op (not jetton transfer)
            const badPayload = beginCell()
                .storeUint(0xdeadbeef, 32) // not jetton transfer op
                .storeUint(0, 64)
                .endCell();

            const body = beginCell()
                .storeUint(Opcodes.withdraw_jetton, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('0.1'))
                .storeAddress(testReceiver.address)
                .storeRef(badPayload)
                .endCell();

            const res = await owner.send({
                to: wallet.address,
                value: toNano('0.5'),
                body,
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: owner.address,
                aborted: true,
                exitCode: ErrorsV5.invalid_message_operation
            });
        });
    });

    describe('set_signature_allowed', () => {
        it('should disable external messages when owner sends false', async () => {
            expect(await wallet.getIsSignatureAllowed()).toBe(true);

            const body = beginCell()
                .storeUint(Opcodes.set_signature_allowed, 32)
                .storeUint(0, 64)
                .storeInt(0, 1) // false (disable)
                .endCell();

            const res = await owner.send({
                to: wallet.address,
                value: toNano('0.05'),
                body,
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: owner.address,
                op: Opcodes.set_signature_allowed,
                aborted: false
            });

            expect(await wallet.getIsSignatureAllowed()).toBe(false);

            // External messages should now be rejected
            const seqNo = await wallet.getSeqno();
            await expect(
                wallet.sendMessagesExternal(
                    walletId,
                    curTime() + 1000,
                    seqNo,
                    keys.secretKey,
                    [mockMessage]
                )
            ).rejects.toThrow();
            expect(await wallet.getSeqno()).toBe(seqNo);
        });

        it('should re-enable external messages when owner sends true', async () => {
            // First disable
            await owner.send({
                to: wallet.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(Opcodes.set_signature_allowed, 32)
                    .storeUint(0, 64)
                    .storeInt(0, 1) // false (disable)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });
            expect(await wallet.getIsSignatureAllowed()).toBe(false);

            // Then re-enable
            const res = await owner.send({
                to: wallet.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(Opcodes.set_signature_allowed, 32)
                    .storeUint(0, 64)
                    .storeInt(-1, 1) // true (enable)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: owner.address,
                aborted: false
            });

            expect(await wallet.getIsSignatureAllowed()).toBe(true);

            // External messages should work again
            const seqNo = await wallet.getSeqno();
            const extRes = await wallet.sendMessagesExternal(
                walletId,
                curTime() + 1000,
                seqNo,
                keys.secretKey,
                [mockMessage]
            );
            expect(extRes.transactions).toHaveTransaction({
                on: wallet.address,
                op: Opcodes.auth_signed,
                aborted: false
            });
        });

        it('should reject set_signature_allowed from non-owner', async () => {
            const stranger = await blockchain.treasury('stranger');

            const res = await stranger.send({
                to: wallet.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(Opcodes.set_signature_allowed, 32)
                    .storeUint(0, 64)
                    .storeInt(0, 1) // try to disable
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: stranger.address,
                aborted: true,
                exitCode: ErrorsV5.invalid_message_operation
            });

            // Should still be enabled
            expect(await wallet.getIsSignatureAllowed()).toBe(true);
        });

        it('should not change seqno after set_signature_allowed', async () => {
            const seqnoBefore = await wallet.getSeqno();

            await owner.send({
                to: wallet.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(Opcodes.set_signature_allowed, 32)
                    .storeUint(0, 64)
                    .storeInt(0, 1)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(await wallet.getSeqno()).toBe(seqnoBefore);
        });

        it('should preserve all storage fields after toggle', async () => {
            const seqnoBefore = await wallet.getSeqno();
            const walletIdBefore = await wallet.getSubwalletId();
            const publicKeyBefore = await wallet.getPublicKey();

            // Disable
            await owner.send({
                to: wallet.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(Opcodes.set_signature_allowed, 32)
                    .storeUint(0, 64)
                    .storeInt(0, 1)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(await wallet.getIsSignatureAllowed()).toBe(false);
            expect(await wallet.getSeqno()).toBe(seqnoBefore);
            expect(await wallet.getSubwalletId()).toBe(walletIdBefore);
            expect(await wallet.getPublicKey()).toBe(publicKeyBefore);

            // Re-enable
            await owner.send({
                to: wallet.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(Opcodes.set_signature_allowed, 32)
                    .storeUint(0, 64)
                    .storeInt(-1, 1)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(await wallet.getIsSignatureAllowed()).toBe(true);
            expect(await wallet.getSeqno()).toBe(seqnoBefore);
            expect(await wallet.getSubwalletId()).toBe(walletIdBefore);
            expect(await wallet.getPublicKey()).toBe(publicKeyBefore);
        });

        it('should allow internal ops (withdraw_ton) when signature is disabled', async () => {
            // Disable external
            await owner.send({
                to: wallet.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(Opcodes.set_signature_allowed, 32)
                    .storeUint(0, 64)
                    .storeInt(0, 1)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });
            expect(await wallet.getIsSignatureAllowed()).toBe(false);

            // withdraw_ton should still work from owner
            const res = await owner.send({
                to: wallet.address,
                value: toNano('0.5'),
                body: beginCell()
                    .storeUint(Opcodes.withdraw_ton, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano('1'))
                    .storeAddress(testReceiver.address)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: owner.address,
                op: Opcodes.withdraw_ton,
                aborted: false,
                outMessagesCount: 1
            });
        });

        it('should allow internal ops (withdraw_jetton) when signature is disabled', async () => {
            // Disable external
            await owner.send({
                to: wallet.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(Opcodes.set_signature_allowed, 32)
                    .storeUint(0, 64)
                    .storeInt(0, 1)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });
            expect(await wallet.getIsSignatureAllowed()).toBe(false);

            // withdraw_jetton should still work from owner
            const jettonPayload = AgentWalletV5.buildJettonTransferPayload({
                jettonAmount: toNano('50'),
                toAddress: owner.address,
                responseAddress: owner.address
            });

            const res = await owner.send({
                to: wallet.address,
                value: toNano('0.5'),
                body: beginCell()
                    .storeUint(Opcodes.withdraw_jetton, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano('0.1'))
                    .storeAddress(testReceiver.address)
                    .storeRef(jettonPayload)
                    .endCell(),
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(res.transactions).toHaveTransaction({
                on: wallet.address,
                from: owner.address,
                op: Opcodes.withdraw_jetton,
                aborted: false,
                outMessagesCount: 1
            });
        });
    });
});
