import http from 'node:http';
import { once } from 'node:events';
import { PublicKey } from '@solana/web3.js';
export async function startAirdropRpc(ledger, { afterSend, beforeStatus } = {}) {
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); let result;
      switch (body.method) {
        case 'getGenesisHash': result = await ledger.connection.getGenesisHash(); break;
        case 'getBalance': result = await ledger.connection.getBalanceAndContext(); break;
        case 'getRecentPrioritizationFees': result = []; break;
        case 'getMinimumBalanceForRentExemption': result = await ledger.connection.getMinimumBalanceForRentExemption(...body.params); break;
        case 'getMultipleAccounts': {
          result = await ledger.connection.getMultipleAccountsInfoAndContext(body.params[0].map((key) => new PublicKey(key)), body.params[1]);
          result.value = result.value.map((value) => value && ({ ...value, owner: value.owner.toBase58(), data: [value.data.toString('base64'), 'base64'] })); break;
        }
        case 'getLatestBlockhash': result = { context: { slot: ledger.state.slot }, value: await ledger.connection.getLatestBlockhash() }; break;
        case 'getFeeForMessage': result = await ledger.connection.getFeeForMessage(); break;
        case 'getSignatureStatuses': await beforeStatus?.(); result = await ledger.connection.getSignatureStatuses(...body.params); break;
        case 'getTransaction': result = ledger.rpcReceipt(body.params[0]); break;
        case 'sendTransaction': result = await ledger.connection.sendRawTransaction(Buffer.from(body.params[0], 'base64')); await afterSend?.(body.params[0]); break;
        default: throw new Error(`Unexpected airdrop RPC method ${body.method}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) { errors.push(error); res.writeHead(500); res.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { errors, url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
