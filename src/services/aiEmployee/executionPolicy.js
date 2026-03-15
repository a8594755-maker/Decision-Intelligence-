export const EXECUTION_MODES = Object.freeze({
  MANUAL_APPROVE: 'manual_approve',
  AUTO_RUN: 'auto_run',
});

export function resolveExecutionMode(...candidates) {
  for (const candidate of candidates) {
    if (candidate === EXECUTION_MODES.AUTO_RUN || candidate === EXECUTION_MODES.MANUAL_APPROVE) {
      return candidate;
    }
  }

  return EXECUTION_MODES.MANUAL_APPROVE;
}

export function shouldAutoRun(candidate) {
  return resolveExecutionMode(candidate) === EXECUTION_MODES.AUTO_RUN;
}

export default {
  EXECUTION_MODES,
  resolveExecutionMode,
  shouldAutoRun,
};
