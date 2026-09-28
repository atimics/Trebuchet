import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, constants } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import * as bundles from '@irys/bundles';
import buildIrysTransaction from '@irys/upload-core/esm/transaction';
import Utils from '@irys/upload-core/esm/utils';
import { solSweepChain, sweepWallet, sweepDestination } from '../../packages/runtime/test/fixtures/sol-sweep-chain.mjs';
import { createIrysUploadTransport } from '../../irysUploadTransport.js';

export { sweepWallet, sweepDestination };
const receiptKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const receiptPublic = receiptKeys.publicKey.export({ format: 'jwk' }).n;
export const uploadNodeUrl = 'https://storage.example.invalid';

export function uploadChain() {
  const chain = solSweepChain(), { connection, state } = chain;
  Object.assign(state, { storageBalance: 0, storagePrice: 10000, acknowledged: new Set(), uploads: new Map(), uploadWires: [], uploadAttempts: 0,
    receiptKey: receiptPublic, beforeUpload: null, afterUpload: null, afterAcknowledge: null, hideReceipts: false, lookupTransform: (value) => value, uploadReceiptTransform: (value) => value });
  connection.getMultipleAccountsInfoAndContext = async (keys) => ({ context: { slot: state.slot }, value: keys.map((key) => ({
    data: Buffer.alloc(0), executable: false, owner: SystemProgram.programId, rentEpoch: 0,
    lamports: key.equals(sweepWallet.publicKey) ? state.balance : 1000,
  })) });
  const signer = new bundles.SolanaSigner(bs58.encode(sweepWallet.secretKey));
  const irys = {
    bundles, tokenConfig: { getSigner: () => signer },
    createTransaction: (bytes, options) => new irys.IrysTransaction(bytes, irys, options),
    verifyReceipt: (receipt) => Utils.verifyReceipt(bundles, receipt),
    getPrice: async () => String(state.storagePrice),
    getBalance: async (wallet) => { assert.equal(wallet, sweepWallet.publicKey.toBase58()); return String(state.storageBalance); },
    utils: { getBundlerAddress: async (token) => { assert.equal(token, 'solana'); return sweepDestination; } },
    api: {
      getConfig: () => ({ url: new URL(uploadNodeUrl) }),
      get: async (url) => { assert.equal(url, '/public'); return { status: 200, data: state.receiptKey }; },
      post: async (url, body) => {
        assert.equal(url, '/graphql');
        const id = body.variables.ids.find((value) => state.uploads.has(value)), receipt = !state.hideReceipts && state.uploads.get(id);
        return state.lookupTransform({ status: 200, data: { data: { transactions: { edges: receipt ? [{ node: { id: receipt.id, receipt } }] : [] } } } });
      },
    },
    funder: { submitFundTransaction: async (signature) => {
      const receipt = state.receipts.get(signature); assert.ok(receipt);
      if (!state.acknowledged.has(signature)) {
        const index = receipt.transaction.message.staticAccountKeys.findIndex((key) => key.toBase58() === sweepDestination);
        state.storageBalance += receipt.meta.postBalances[index] - receipt.meta.preBalances[index];
        state.acknowledged.add(signature);
      }
      await state.afterAcknowledge?.();
      return { status: 202 };
    } },
    uploader: { uploadTransaction: async (item) => {
      await state.beforeUpload?.(item);
      state.uploadAttempts++; state.uploadWires.push(Buffer.from(item.getRaw()));
      if (!state.uploads.has(item.id)) {
        assert.ok(state.storageBalance >= state.storagePrice); state.storageBalance -= state.storagePrice;
        const receipt = { id: state.receiptEncoding === 'base64url' ? item.rawId.toString('base64url') : item.id, public: receiptPublic, version: '1.0.0', timestamp: 1700000000000, deadlineHeight: 123456 };
        const digest = await bundles.deepHash(['Bundlr', receipt.version, receipt.id, String(receipt.deadlineHeight), String(receipt.timestamp)].map(bundles.stringToBuffer));
        receipt.signature = sign('sha256', digest, { key: receiptKeys.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url');
        state.uploads.set(item.id, receipt);
      }
      await state.afterUpload?.(item);
      return { status: 200, data: state.uploadReceiptTransform(state.uploads.get(item.id)) };
    } },
  };
  irys.IrysTransaction = buildIrysTransaction(irys);
  return { ...chain, irys, transport: createIrysUploadTransport({ irys, gatewayUrl: 'https://gateway.example.invalid' }) };
}
