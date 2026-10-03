// autoResume.js
//
// Launch steps after token creation are durable: each run first checks the chain for whatever the
// last run left unconfirmed, then continues. So when one is interrupted by something passing (an
// unconfirmed transfer, a lagging or rate-limited RPC node), the right move is to run it again,
// not to tell the person to. This does that, a bounded number of times, and only gives up on a
// cause that another run cannot change: a missing input, a decision, or a rule.

const TRANSIENT_CODES = new Set([
  'EXECUTION_RECOVERY_REQUIRED', 'EXECUTION_INTERRUPTED', 'CHAIN_STATE_UNAVAILABLE', 'LIQUIDITY_INTERRUPTED',
  'TRANSACTION_PENDING', 'RPC_UNAVAILABLE', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'UND_ERR_SOCKET',
]);
const FINAL_CODES = new Set([
  'INSUFFICIENT_FUNDS', 'SPEND_LIMIT_EXCEEDED', 'EXECUTION_APPROVAL_REQUIRED', 'NETWORK_MISMATCH', 'OPERATION_CONFLICT',
  'WALLET_MISMATCH', 'SIGNER_MISMATCH', 'SECRET_PIN_LOCKED', 'PIN_LOCKED', 'TRANSACTION_FAILED', 'RECOVERY_STORAGE_UNAVAILABLE',
  'SUPPORT_POSITION_EXISTS', 'QUOTE_EXPIRED', 'TOKEN_PROGRAM_MISMATCH', 'TOKEN_EXTENSION_REQUIRES_REVIEW', 'INVALID_INPUT',
]);

export function isTransientLaunchError(error) {
  if (!error) return false;
  // A wrapper names the step; the cause decides whether another run can help.
  const cause = error.errorDetails || error.payload?.errorDetails || error.cause || null;
  const codes = [cause?.code, error.code, error.payload?.code].filter(Boolean);
  if (codes.some((code) => FINAL_CODES.has(code))) return false;
  // "Needs recovery" with no cause is a refusal: the wallet is held by an earlier step, or the request
  // does not match the saved plan. Another run meets the same refusal. An interrupted step names its cause.
  if (!cause && codes.length && codes.every((code) => code === 'EXECUTION_RECOVERY_REQUIRED')) return false;
  if (codes.some((code) => TRANSIENT_CODES.has(code))) return true;
  const text = `${error.message || ''} ${cause?.message || ''}`;
  return /429|too many requests|timed? ?out|fetch failed|socket hang up|minimum context slot|blockhash not found|block height exceeded|not confirmed/i.test(text);
}

export async function withAutoResume(run, { attempts = 6, delaysMs = [3000, 6000, 12000, 20000, 30000], sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), label = 'launch step', log = console } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isTransientLaunchError(error)) throw error;
      const wait = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
      log.warn?.(`[auto-resume] ${label} attempt ${attempt} stopped (${error.errorDetails?.message || error.message}); running it again in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
}

// Wrap the steps that are safe to run again. Token creation is not one of them.
export function autoResumingLaunchServices(services, options = {}) {
  const wrap = (name) => (...args) => withAutoResume(() => services[name](...args), { ...options, label: name });
  return { ...services, finishToken: wrap('finishToken'), revealMetadata: wrap('revealMetadata'), createLiquidity: wrap('createLiquidity'),
    resumeLiquidity: wrap('resumeLiquidity'), transferAssets: wrap('transferAssets'), runAirdrop: wrap('runAirdrop') };
}
