import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractABI,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    toNano
} from '@ton/core';

export const Opcodes = {
    action_send_msg: 0x0ec3c86d,
    auth_signed: 0x7369676e,
    auth_signed_internal: 0x73696e74,
    withdraw_ton: 0x746f6e77,
    withdraw_jetton: 0x6a657477,
    topup_action: 0x746f7075,
    set_signature_allowed: 0x73657473,
    jetton_transfer: 0x0f8a7ea5
};

export type AgentWalletV5Config = {
    signatureAllowed: boolean;
    seqno: number;
    walletId: number;
    publicKey: Buffer;
    ownerAddress: Address;
    hashPrompt?: bigint;
};

export function agentWalletV5ConfigToCell(config: AgentWalletV5Config): Cell {
    const builder = beginCell()
        .storeBit(config.signatureAllowed)
        .storeUint(config.seqno, 32)
        .storeUint(config.walletId, 32)
        .storeBuffer(config.publicKey, 32)
        .storeAddress(config.ownerAddress);

    if (config.hashPrompt !== undefined) {
        builder.storeUint(config.hashPrompt, 256);
    }

    return builder.endCell();
}

export class AgentWalletV5 implements Contract {
    abi: ContractABI = { name: 'AgentWalletV5' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new AgentWalletV5(address);
    }

    static createFromConfig(config: AgentWalletV5Config, code: Cell, workchain = 0) {
        const data = agentWalletV5ConfigToCell(config);
        const init = { code, data };
        return new AgentWalletV5(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async getSeqno(provider: ContractProvider): Promise<number> {
        const result = await provider.get('seqno', []);
        return result.stack.readNumber();
    }

    async getSubwalletId(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_subwallet_id', []);
        return result.stack.readNumber();
    }

    async getPublicKey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_public_key', []);
        return result.stack.readBigNumber();
    }

    async getIsSignatureAllowed(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('is_signature_allowed', []);
        return result.stack.readNumber() !== 0;
    }

    async getHashPrompt(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_hash_prompt', []);
        return result.stack.readBigNumber();
    }

    async sendSetSignatureAllowed(provider: ContractProvider, via: Sender, opts: {
        value: bigint;
        queryId?: bigint;
        isAllowed: boolean;
    }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.set_signature_allowed, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeBit(opts.isAllowed)
                .endCell(),
        });
    }

    async sendWithdrawTon(provider: ContractProvider, via: Sender, opts: {
        value: bigint;
        queryId?: bigint;
        tonAmount: bigint;
        toAddress: Address;
    }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.withdraw_ton, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeCoins(opts.tonAmount)
                .storeAddress(opts.toAddress)
                .endCell(),
        });
    }

    async sendWithdrawJetton(provider: ContractProvider, via: Sender, opts: {
        value: bigint;
        queryId?: bigint;
        tonAmount: bigint;
        jettonWalletAddress: Address;
        jettonPayload: Cell;
    }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.withdraw_jetton, 32)
                .storeUint(opts.queryId ?? 0n, 64)
                .storeCoins(opts.tonAmount)
                .storeAddress(opts.jettonWalletAddress)
                .storeRef(opts.jettonPayload)
                .endCell(),
        });
    }

    static buildJettonTransferPayload(opts: {
        queryId?: bigint;
        jettonAmount: bigint;
        toAddress: Address;
        responseAddress: Address;
        forwardTonAmount?: bigint;
        forwardPayload?: Cell;
        customPayload?: Cell;
    }): Cell {
        const builder = beginCell()
            .storeUint(Opcodes.jetton_transfer, 32)
            .storeUint(opts.queryId ?? 0n, 64)
            .storeCoins(opts.jettonAmount)
            .storeAddress(opts.toAddress)
            .storeAddress(opts.responseAddress)
            .storeMaybeRef(opts.customPayload ?? null)
            .storeCoins(opts.forwardTonAmount ?? 0n);

        if (opts.forwardPayload) {
            builder.storeBit(true).storeRef(opts.forwardPayload);
        } else {
            builder.storeBit(false);
        }

        return builder.endCell();
    }
}
