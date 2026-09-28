import bs58 from 'bs58';
import { uploadIdCandidates } from '@trebuchet/runtime/storage-payment';
import { PublicKey } from '@solana/web3.js';
import { uploadDigest } from '@trebuchet/runtime/upload-store';

const paused = (message) => Object.assign(new Error(message), { code: 'CHAIN_STATE_UNAVAILABLE' });
const integer = (value) => {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw paused('Read an exact storage amount in lamports');
  return Number(text);
};
const receiptFields = (value, expected) => {
  if (!value || !uploadIdCandidates(value.id).some((bytes) => bytes.toString('hex') === expected.rawId) || value.public !== expected.publicKey
      || typeof value.version !== 'string' || !value.version || value.version.length > 32
      || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0 || !Number.isSafeInteger(value.deadlineHeight) || value.deadlineHeight < 0
      || typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{128,2048}$/.test(value.signature)) throw paused('Read a complete receipt from the saved storage node');
  return Object.fromEntries(['id', 'public', 'version', 'timestamp', 'deadlineHeight', 'signature'].map((field) => [field, value[field]]));
};

// Use the installed Irys SDK for data-item signing and receipt verification.
// All SOL funding goes through the host's shared execution engine.
export function createIrysUploadTransport({ irys, gatewayUrl }) {
  const dataItem = (wire) => irys.createTransaction(Buffer.from(wire), { dataIsRawTransaction: true });
  return {
    async identity() {
      const paymentAddress = await irys.utils.getBundlerAddress('solana');
      const response = await irys.api.get('/public');
      if (response.status !== 200 || typeof response.data !== 'string') throw paused('Read the storage node receipt key');
      return { paymentAddress, receiptKey: response.data, nodeUrl: String(irys.api.getConfig().url), gatewayUrl };
    },
    async prepare(bytes, tags) {
      const item = irys.createTransaction(Buffer.from(bytes), { tags });
      await item.sign();
      return Buffer.from(item.getRaw());
    },
    async inspect(wire) {
      const item = dataItem(wire);
      if (item.signatureType !== 2 || item.rawTarget.length || await item.isValid() !== true) throw paused('Verify the signed Solana upload data item');
      return { id: item.id, rawId: item.rawId.toString('hex'), walletPublicKey: new PublicKey(item.rawOwner).toBase58(), contentDigest: uploadDigest(item.rawData), byteLength: item.rawData.length, tags: item.tags };
    },
    quote: async ({ byteLength, tags }) => integer(await irys.getPrice(byteLength, { tags })),
    balance: async (walletPublicKey) => integer(await irys.getBalance(walletPublicKey)),
    async acknowledge(signature) {
      if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) throw paused('Use the verified storage funding signature');
      const response = await irys.funder.submitFundTransaction(signature);
      if (![200, 202].includes(response?.status)) throw paused('Verify storage node acceptance of the funding signature');
    },
    async findReceipt(id, publicKey, rawId) {
      const bytes = Buffer.from(rawId, 'hex');
      if (bytes.length !== 32 || !uploadIdCandidates(id).some((value) => value.equals(bytes))) throw paused('Verify the saved upload identity');
      const ids = [...new Set([id, bs58.encode(bytes), bytes.toString('base64url')])];
      const response = await irys.api.post('/graphql', { query: 'query Receipt($ids: [String!]) { transactions(ids: $ids) { edges { node { id receipt { signature timestamp version deadlineHeight } } } } }', variables: { ids } });
      const edges = response?.data?.data?.transactions?.edges;
      if (response.status !== 200 || response.data.errors?.length || !Array.isArray(edges) || edges.length > 1) throw paused('Read a complete storage receipt lookup');
      if (!edges.length) return null;
      const node = edges[0]?.node;
      if (!node?.id || !uploadIdCandidates(node.id).some((value) => value.equals(bytes)) || !node.receipt) throw paused('Read the receipt for the exact saved upload');
      return { ...node.receipt, id: node.id, public: publicKey };
    },
    async upload(wire) {
      const response = await irys.uploader.uploadTransaction(dataItem(wire));
      if (![200, 202].includes(response?.status)) throw paused('Verify storage node acceptance of the signed upload');
      return response.data;
    },
    async verifyReceipt(value, expected) {
      const receipt = receiptFields(value, expected);
      if (await irys.verifyReceipt(receipt) !== true) throw paused('Verify the storage receipt signature');
      return receipt;
    },
  };
}
