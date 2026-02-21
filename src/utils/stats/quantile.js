const toFiniteNumbers = (values = []) => {
  if (!Array.isArray(values)) {
    throw new Error('quantile: values must be an array of numbers');
  }

  const numeric = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (numeric.length === 0) {
    throw new Error('quantile: values array must contain at least one finite number');
  }

  return numeric;
};

export function quantile(values = [], q = 0.5) {
  const qNum = Number(q);
  if (!Number.isFinite(qNum) || qNum < 0 || qNum > 1) {
    throw new Error('quantile: q must be a finite number in [0, 1]');
  }

  const sorted = toFiniteNumbers(values).sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];

  const position = (sorted.length - 1) * qNum;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }

  const weightUpper = position - lowerIndex;
  const weightLower = 1 - weightUpper;
  return (sorted[lowerIndex] * weightLower) + (sorted[upperIndex] * weightUpper);
}

export default {
  quantile
};
