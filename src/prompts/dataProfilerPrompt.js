/**
 * Backward-compatible data profiler prompt entrypoint.
 * Uses the strict System Brain JSON contract.
 */

import { buildSystemBrainPrompt } from './diJsonContracts';

export const buildDataProfilerPrompt = (payload) => {
  return buildSystemBrainPrompt(payload);
};

export default buildDataProfilerPrompt;
