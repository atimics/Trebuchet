// A successful finish-token recovery can adopt metadata that landed on-chain
// immediately before an RPC propagation error. In that case the original
// metadata_account_created progress callback may never have reached the
// journal, even though the subsequent recovery verified the token and marked
// it safe. Treat that verified repair state as metadata evidence so readiness
// does not keep routing an already-finished mint back through repair.
export function tokenCreationComplete(journal, tokenMint = journal?.token?.mint) {
  const mint = String(tokenMint || '').trim();
  if (!mint || journal?.token?.mintAuthorityRenounced !== true) return false;

  const events = Array.isArray(journal?.events) ? journal.events : [];
  const supplyRecorded = events.some((event) => event?.stage === 'supply_minted');
  const metadataRecorded = events.some((event) => event?.stage === 'metadata_account_created');
  const metadataAdoptedBySafeRepair = journal?.token?.isSafe === true;

  return supplyRecorded && (metadataRecorded || metadataAdoptedBySafeRepair);
}
