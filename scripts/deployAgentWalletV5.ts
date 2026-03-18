import { Address, toNano } from '@ton/core';
import { AgentWalletV5 } from '../wrappers/AgentWalletV5';
import { compile, NetworkProvider } from '@ton/blueprint';
import { getSecureRandomBytes, keyPairFromSeed, mnemonicNew, mnemonicToPrivateKey, mnemonicToSeed } from '@ton/crypto';
import { hash } from 'crypto';

export async function run(provider: NetworkProvider) {
    const mnemonicArray = await mnemonicNew();

    // derive private and public keys from the mnemonic
    const keyPair = await mnemonicToPrivateKey(mnemonicArray); 


    const senderAddress = provider.sender().address;

    if (!senderAddress) {
        throw new Error('Sender address is required');
    }

    const prompt = "TRADE! TRADE! MORE MONEY!!!";
    const promptHashHex = hash('sha256', prompt, 'hex');
    const promptHash = BigInt('0x' + promptHashHex);

    const walletV5 = provider.open(
        AgentWalletV5.createFromConfig(
            {
                signatureAllowed: true,
                seqno: 0,
                walletId: 0,
                publicKey: keyPair.publicKey,
                ownerAddress: senderAddress,
                hashPrompt: promptHash
            },
            await compile('AgentWalletV5')
        )
    );

    await walletV5.sendDeploy(provider.sender(), toNano('15'));
    await provider.waitForDeploy(walletV5.address);

    console.log('Wallet deployed at:', walletV5.address);
    console.log("Public Key: " + keyPair.publicKey.toString('hex'));
    console.log("Private Key: " + keyPair.secretKey.toString('hex'));
    console.log("Mnemonic: " + mnemonicArray.join(' '));
}
