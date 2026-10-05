import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';

export function recipientList(input) {
  const lines = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/).filter(Boolean);
  if (!lines.length || lines.length > 128) throw new Error('Choose between 1 and 128 recipients');
  const recipients = lines.map((v) => new PublicKey(String(v).trim()).toBase58());
  if (new Set(recipients).size !== recipients.length || recipients.some((v) => !PublicKey.isOnCurve(new PublicKey(v).toBytes()))) throw new Error('Use a unique wallet address for each recipient');
  return recipients;
}
export function feeNftPlan({ collection, source, recipients, creator, seed, programId, network }) {
  const wallets = recipientList(recipients);
  const items = collection.items.filter((item) => item.mintSignature && item.key?.address);
  if (!collection.collectionSignature || items.length !== collection.items.length || items.length !== wallets.length) throw new Error('Mint one branded NFT for each recipient in the NFTs view');
  const shares = items.map((item, index) => ({ index, asset: new PublicKey(item.key.address).toBase58(), name: item.name, recipient: wallets[index], weight: '1' }));
  if (new Set(shares.map((v) => v.asset)).size !== shares.length) throw new Error('Each fee share needs its own NFT');
  const plan = { schema: 'trebuchet.fee-nfts.v1', name: collection.config.name, collectionId: collection.id, collection: collection.collectionKey.address,
    creator: new PublicKey(creator).toBase58(), seed, programId: new PublicKey(programId).toBase58(), network, source, count: shares.length, totalWeight: String(shares.length), shares,
    transferRule: 'The current NFT owner receives its unclaimed fees. Paid amounts stay with the NFT.',
    backingRule: 'All LP fees from this permanently locked position belong to the collection.' };
  return { ...plan, digest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
}
