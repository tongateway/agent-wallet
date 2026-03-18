import {
    Cell,
    beginCell,
    Sender,
    ContractProvider,
    SendMode,
    MessageRelaxed,
    Address,
    toNano,
    OutActionSendMsg,
    Builder,
    storeOutList,
    contractAddress
} from '@ton/core';
import { AgentWalletV5, AgentWalletV5Config, Opcodes, agentWalletV5ConfigToCell } from './AgentWalletV5';
import { sign } from '@ton/crypto';

export type MessageOut = {
    message: MessageRelaxed;
    mode: SendMode;
};

export type WalletActions = {
    wallet?: OutActionSendMsg[] | Cell;
};

export function message2action(msg: MessageOut): OutActionSendMsg {
    return {
        type: 'sendMsg',
        mode: msg.mode,
        outMsg: msg.message
    };
}

function storeWalletActions(actions: WalletActions) {
    return (builder: Builder) => {
        if (actions.wallet) {
            let actionCell: Cell | null = null;
            if (actions.wallet instanceof Cell) {
                actionCell = actions.wallet;
            } else if (actions.wallet.length > 0) {
                actionCell = beginCell().store(storeOutList(actions.wallet)).endCell();
            }
            builder.storeMaybeRef(actionCell);
        } else {
            builder.storeBit(false);
        }
    };
}

export class AgentWalletV5Test {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromConfig(config: AgentWalletV5Config, code: Cell, workchain = 0) {
        const data = agentWalletV5ConfigToCell(config);
        const init = { code, data };
        return new AgentWalletV5Test(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell()
        });
    }

    static requestMessage(
        internal: boolean,
        wallet_id: number,
        valid_until: number,
        seqno: bigint | number,
        actions: WalletActions,
        key?: Buffer
    ) {
        const op = internal ? Opcodes.auth_signed_internal : Opcodes.auth_signed;
        const msgBody = beginCell()
            .storeUint(op, 32)
            .storeUint(wallet_id, 32)
            .storeUint(valid_until, 32)
            .storeUint(seqno, 32)
            .store(storeWalletActions(actions))
            .endCell();
        return key ? AgentWalletV5Test.signRequestMessage(msgBody, key) : msgBody;
    }

    static signRequestMessage(msg: Cell, key: Buffer) {
        const signature = sign(msg.hash(), key);
        return beginCell().storeSlice(msg.asSlice()).storeBuffer(signature).endCell();
    }

    async sendRawExternal(provider: ContractProvider, body: Cell) {
        return await (provider as any).external(body);
    }

    async sendMessagesExternal(
        provider: ContractProvider,
        wallet_id: number,
        valid_until: number,
        seqno: bigint | number,
        key: Buffer,
        messages: MessageOut[]
    ) {
        const actions: OutActionSendMsg[] = messages.map(message2action);
        return await (provider as any).external(
            AgentWalletV5Test.requestMessage(
                false,
                wallet_id,
                valid_until,
                seqno,
                { wallet: actions },
                key
            )
        );
    }

    async sendMessagesInternal(
        provider: ContractProvider,
        via: Sender,
        wallet_id: number,
        valid_until: number,
        seqno: bigint | number,
        key: Buffer,
        messages: MessageOut[],
        value: bigint = toNano('0.05')
    ) {
        const actions: OutActionSendMsg[] = messages.map(message2action);
        return await provider.internal(via, {
            value,
            body: AgentWalletV5Test.requestMessage(
                true,
                wallet_id,
                valid_until,
                seqno,
                { wallet: actions },
                key
            ),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }

    async sendInternalSignedMessage(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            body: Cell;
        }
    ) {
        return await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeSlice(opts.body.beginParse()).endCell()
        });
    }

    async getSeqno(provider: ContractProvider) {
        const result = await provider.get('seqno', []);
        return result.stack.readNumber();
    }

    async getSubwalletId(provider: ContractProvider) {
        const result = await provider.get('get_subwallet_id', []);
        return result.stack.readNumber();
    }

    async getPublicKey(provider: ContractProvider) {
        const result = await provider.get('get_public_key', []);
        return result.stack.readBigNumber();
    }

    async getIsSignatureAllowed(provider: ContractProvider) {
        const result = await provider.get('is_signature_allowed', []);
        return result.stack.readNumber() !== 0;
    }

    async getHashPrompt(provider: ContractProvider) {
        const result = await provider.get('get_hash_prompt', []);
        return result.stack.readBigNumber();
    }
}
