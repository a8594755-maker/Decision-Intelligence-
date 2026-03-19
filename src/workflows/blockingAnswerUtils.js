const clonePlain = (value, fallback) => {
  if (!value || typeof value !== 'object') return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const toPathSegments = (path) => (
  String(path || '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
);

const isArrayIndex = (segment) => /^\d+$/.test(segment);

function setDeepValue(target, path, value) {
  const segments = toPathSegments(path);
  if (segments.length === 0) return false;

  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    const nextShouldBeArray = isArrayIndex(nextSegment);

    if (isArrayIndex(segment)) {
      const numericIndex = Number(segment);
      if (!Array.isArray(cursor)) return false;
      if (cursor[numericIndex] == null || typeof cursor[numericIndex] !== 'object') {
        cursor[numericIndex] = nextShouldBeArray ? [] : {};
      }
      cursor = cursor[numericIndex];
      continue;
    }

    if (cursor[segment] == null || typeof cursor[segment] !== 'object') {
      cursor[segment] = nextShouldBeArray ? [] : {};
    }
    cursor = cursor[segment];
  }

  const lastSegment = segments[segments.length - 1];
  if (isArrayIndex(lastSegment)) {
    const numericIndex = Number(lastSegment);
    if (!Array.isArray(cursor)) return false;
    cursor[numericIndex] = value;
    return true;
  }

  cursor[lastSegment] = value;
  return true;
}

const getAnswerCandidates = (question, index) => {
  const candidates = [
    question?.id,
    String(index),
    `q_${index}`,
    question?.question,
  ];
  return candidates
    .map((value) => (value == null ? null : String(value)))
    .filter(Boolean);
};

const normalizeSelectableAnswer = (value, options = []) => {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, value: null };

  const matched = (Array.isArray(options) ? options : []).find((option) => String(option).trim() === raw);
  return matched == null
    ? { ok: false, value: null }
    : { ok: true, value: matched };
};

function normalizeAnswerValue(question, rawValue) {
  if (rawValue == null) return { ok: false, value: null, reason: 'missing_answer' };

  const answerType = String(question?.answer_type || 'text').trim().toLowerCase();
  if (answerType === 'number') {
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) {
      return { ok: false, value: null, reason: 'invalid_number' };
    }
    return { ok: true, value: numeric };
  }

  if (answerType === 'single_choice' || answerType === 'single_select') {
    const normalized = normalizeSelectableAnswer(rawValue, question?.options || []);
    return normalized.ok
      ? { ok: true, value: normalized.value }
      : { ok: false, value: null, reason: 'invalid_option' };
  }

  const text = String(rawValue).trim();
  if (!text) return { ok: false, value: null, reason: 'missing_answer' };
  return { ok: true, value: text };
}

export function applyBlockingAnswerBindings({
  questions = [],
  answers = {},
  settings = {},
  contractJson = {},
}) {
  const nextSettings = clonePlain(settings, {});
  const nextContractJson = clonePlain(contractJson, {});
  const answeredQuestions = [];
  const appliedBindings = [];
  const validationErrors = [];

  (Array.isArray(questions) ? questions : []).forEach((question, index) => {
    const answerKey = getAnswerCandidates(question, index).find((candidate) => hasOwn(answers, candidate));
    if (!answerKey) return;

    const normalized = normalizeAnswerValue(question, answers[answerKey]);
    if (!normalized.ok) {
      validationErrors.push({
        id: question?.id || null,
        question: question?.question || null,
        reason: normalized.reason,
      });
      return;
    }

    const bindTo = String(question?.bind_to || '').trim();
    answeredQuestions.push({
      id: question?.id || null,
      question: question?.question || null,
      bind_to: bindTo || null,
      answer_type: question?.answer_type || 'text',
      answer: normalized.value,
    });

    if (!bindTo) return;

    if (bindTo.startsWith('settings.')) {
      const changed = setDeepValue(nextSettings, bindTo.slice('settings.'.length), normalized.value);
      if (changed) {
        appliedBindings.push({ bind_to: bindTo, answer: normalized.value, target: 'settings' });
      }
      return;
    }

    if (bindTo.startsWith('contract.')) {
      const changed = setDeepValue(nextContractJson, bindTo.slice('contract.'.length), normalized.value);
      if (changed) {
        appliedBindings.push({ bind_to: bindTo, answer: normalized.value, target: 'contract' });
      }
      return;
    }

    if (bindTo.startsWith('mapping.')) {
      const changed = setDeepValue(nextContractJson, bindTo, normalized.value);
      if (changed) {
        appliedBindings.push({ bind_to: bindTo, answer: normalized.value, target: 'contract' });
      }
    }
  });

  return {
    nextSettings,
    nextContractJson,
    answeredQuestions,
    appliedBindings,
    validationErrors,
  };
}

export default {
  applyBlockingAnswerBindings,
};
