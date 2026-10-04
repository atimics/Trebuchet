import {
  ComputeBudgetProgram, PublicKey, SystemInstruction, SystemProgram, TransactionInstruction,
} from '@solana/web3.js';
import { toWeb3JsTransaction } from '@metaplex-foundation/umi-web3js-adapters';
import bs58 from 'bs58';

function lamports(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('The transaction cost is unavailable. Try the estimate again.');
  return amount;
}

export function spendCapLamports(maxSpendSol) {
  const cap = Math.floor(Number(maxSpendSol) * 1_000_000_000);
  if (!Number.isFinite(Number(maxSpendSol)) || !Number.isSafeInteger(cap) || cap <= 0) {
    throw Object.assign(new Error('Review the estimate and approve a valid spend cap first.'), { statusCode: 400 });
  }
  return cap;
}

export function createNftSpendBudget({ maxSpendSol, balanceLamports }) {
  const limit = Math.min(spendCapLamports(maxSpendSol), lamports(balanceLamports));
  let reserved = 0;
  return {
    reserve(cost) {
      const amount = lamports(cost);
      if (amount > limit - reserved) {
        throw Object.assign(new Error('The run reached its approved spend cap. Estimate again and approve a new cap to continue.'), { code: 'NFT_SPEND_CAP' });
      }
      // Keep reservations after send errors: the transaction may have landed.
      reserved += amount;
    },
    get reservedLamports() { return reserved; },
  };
}

async function transactionFee(connection, message) {
  const result = await connection.getFeeForMessage(message, 'confirmed');
  if (result.value == null) throw new Error('The transaction fee is unavailable. Try the estimate again.');
  return lamports(result.value);
}

function systemDebit(instruction, payer) {
  if (!new PublicKey(instruction.programId).equals(SystemProgram.programId)) return 0;
  if (instruction.parsed) {
    const { type, info } = instruction.parsed;
    if (['transfer', 'transferWithSeed', 'createAccount', 'createAccountWithSeed'].includes(type)) {
      return info.source === payer ? lamports(info.lamports) : 0;
    }
    if (type === 'withdrawNonce') return info.nonceAccount === payer ? lamports(info.lamports) : 0;
    if (['allocate', 'allocateWithSeed', 'assign', 'assignWithSeed', 'initializeNonce', 'advanceNonce', 'authorizeNonce', 'upgradeNonce'].includes(type)) return 0;
    throw new Error('The storage or mint transaction cost could not be checked. Try the estimate again.');
  }
  const raw = instruction instanceof TransactionInstruction ? instruction : new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((address) => ({ pubkey: new PublicKey(address), isSigner: false, isWritable: true })),
    data: Buffer.from(bs58.decode(instruction.data)),
  });
  const type = SystemInstruction.decodeInstructionType(raw);
  const decoders = {
    Transfer: SystemInstruction.decodeTransfer,
    TransferWithSeed: SystemInstruction.decodeTransferWithSeed,
    Create: SystemInstruction.decodeCreateAccount,
    CreateWithSeed: SystemInstruction.decodeCreateWithSeed,
    WithdrawNonceAccount: SystemInstruction.decodeNonceWithdraw,
  };
  if (decoders[type]) {
    const decoded = decoders[type].call(SystemInstruction, raw);
    const source = decoded.fromPubkey || decoded.noncePubkey;
    return source.toBase58() === payer ? lamports(decoded.lamports) : 0;
  }
  if (['Allocate', 'AllocateWithSeed', 'Assign', 'AssignWithSeed', 'InitializeNonceAccount', 'AdvanceNonceAccount', 'AuthorizeNonceAccount', 'UpgradeNonceAccount'].includes(type)) return 0;
  throw new Error('The storage or mint transaction cost could not be checked. Try the estimate again.');
}

export async function sendNftTransaction(builder, umi, connection, budget) {
  const prepared = await builder.setLatestBlockhash(umi);
  const transaction = toWeb3JsTransaction(prepared.build(umi));
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: 'confirmed', sigVerify: false, innerInstructions: true,
  });
  if (simulation.value.err) throw new Error(`Mint transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
  if (!Array.isArray(simulation.value.innerInstructions)) throw new Error('The mint transaction cost is unavailable. Try the estimate again.');
  const payer = umi.payer.publicKey.toString();
  // Core uses System Program calls for rent and protocol fees. Count their
  // payer debits instead of the SDK's byte estimate, which is zero for Core.
  const debit = simulation.value.innerInstructions.flatMap((group) => group.instructions)
    .reduce((sum, instruction) => sum + systemDebit(instruction, payer), 0);
  const fee = await transactionFee(connection, transaction.message);
  budget.reserve(debit + fee);
  return prepared.sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });
}

export async function installNftUploadBudget(umi, connection, budget, { allowLocal = false } = {}) {
  if (typeof umi.uploader.irys !== 'function') {
    if (allowLocal) return;
    throw new Error('The storage funding cost is unavailable. Try the estimate again.');
  }
  const irys = await umi.uploader.irys();
  const token = irys.utils?.tokenConfig;
  if (typeof token?.sendTx !== 'function') throw new Error('The storage funding cost is unavailable. Try the estimate again.');
  const payer = umi.payer.publicKey.toString();
  const send = token.sendTx.bind(token);
  // The uploader's internal auto-funding calls this same driver. Wrapping
  // uploader.fund alone would leave those extra transfers outside the cap.
  token.sendTx = async (transaction) => {
    if (transaction.feePayer?.toBase58() !== payer) throw new Error('The storage funding wallet changed. Review the estimate again.');
    let debit = 0;
    for (const instruction of transaction.instructions) {
      if (instruction.programId.equals(ComputeBudgetProgram.programId)) continue;
      if (!instruction.programId.equals(SystemProgram.programId) || SystemInstruction.decodeInstructionType(instruction) !== 'Transfer') {
        throw new Error('The storage funding transaction cost could not be checked. Try the estimate again.');
      }
      const transfer = SystemInstruction.decodeTransfer(instruction);
      if (transfer.fromPubkey.toBase58() !== payer) throw new Error('The storage funding wallet changed. Review the estimate again.');
      debit += lamports(transfer.lamports);
    }
    const fee = await transactionFee(connection, transaction.compileMessage());
    budget.reserve(debit + fee);
    return send(transaction);
  };
}
