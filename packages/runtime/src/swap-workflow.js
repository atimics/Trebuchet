import { createHash } from 'node:crypto';
import { publicJson } from './store.js';

export const ACQUISITION_KIND = 'quote-token-acquisition';
export const swapWorkflowId = (job) => job.plan.workflowId || job.id;
const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');

// A parent keeps the wallet across purchases. Its immutable plan names every
// child and its full reviewed plan before any child can spend.
export function assertSwapWorkflow(store, job) {
  const workflow = store.getWalletWorkflow(job.walletPublicKey);
  let valid = workflow?.id === swapWorkflowId(job);
  if (valid && job.plan.workflowId) {
    const context = workflow.context, plan = context?.plan;
    const index = plan?.purchases?.findIndex((item) => item.id === job.id), child = plan?.purchases?.[index];
    const saved = store.collection('runtime-swaps/v1').load();
    const inOrder = index >= 0 && plan.purchases.slice(0, index).every((item) => saved.find((prior) => prior.id === item.id)?.state === 'confirmed')
      && plan.purchases.slice(index + 1).every((item) => !saved.some((later) => later.id === item.id));
    valid = inOrder && workflow.kind === ACQUISITION_KIND && plan?.walletPublicKey === job.walletPublicKey
      && plan.network === job.plan.network && plan.genesisHash === job.plan.genesisHash
      && context.digest === hash(plan) && child && publicJson(child.plan) === publicJson(job.plan);
  }
  if (!valid) throw Object.assign(new Error('Recover the saved purchase and its wallet reservation'), { code: 'OPERATION_CONFLICT' });
  return workflow;
}

export function finishSwapWorkflow(store, job, evidence) {
  if (job.plan.workflowId) assertSwapWorkflow(store, job);
  else store.finishWalletWorkflow(job.id, evidence);
}
