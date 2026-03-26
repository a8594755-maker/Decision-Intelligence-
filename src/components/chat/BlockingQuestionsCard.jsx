import React, { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Card, Button } from '../ui';

// Derive a stable key for a question (id preferred, fallback to question text).
const questionKey = (q, idx) => q.id || `q_${idx}`;

function QuestionInput({ question, value, onChange, disabled }) {
  const { answer_type, options } = question;
  const isSelect = (answer_type === 'single_select' || answer_type === 'single_choice') && Array.isArray(options) && options.length > 0;

  if (isSelect) {
    return (
      <div className="flex flex-col gap-1 mt-1">
        {options.map((opt) => (
          <label
            key={opt}
            className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-xs
              ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-amber-100 dark:hover:bg-amber-800/30'}
              ${value === opt ? 'font-semibold text-amber-800 dark:text-amber-300' : 'text-[var(--text-secondary)]'}`}
          >
            <input
              type="radio"
              name={question.id || question.question}
              value={opt}
              checked={value === opt}
              disabled={disabled}
              onChange={() => onChange(opt)}
              className="accent-amber-600"
            />
            {opt}
          </label>
        ))}
      </div>
    );
  }

  // free_text / text / number
  return (
    <input
      type={answer_type === 'number' ? 'number' : 'text'}
      className="mt-1 w-full text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-transparent text-[var(--text-primary)] disabled:opacity-50"
      value={value || ''}
      disabled={disabled}
      placeholder="Your answer…"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function BlockingQuestionsCard({ payload, onSubmit }) {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const runId = payload?.run_id || null;
  const profileId = payload?.dataset_profile_id || null;

  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  if (questions.length === 0) return null;

  // Questions that have bind_to are actionable; display-only ones have none.
  const actionable = questions.filter((q) => q.bind_to);
  const displayOnly = questions.filter((q) => !q.bind_to);

  const setAnswer = (key, value) => setAnswers((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = () => {
    // Validate all actionable questions are answered
    const missing = actionable.filter((q) => {
      const key = questionKey(q, questions.indexOf(q));
      const val = answers[key];
      return !val || String(val).trim() === '';
    });

    if (missing.length > 0) {
      setError(`Please answer all questions before submitting.`);
      return;
    }

    setError(null);

    // Build answersById: keyed by question id (or question text as fallback)
    const answersById = {};
    actionable.forEach((q) => {
      const key = questionKey(q, questions.indexOf(q));
      answersById[q.id || key] = answers[key];
    });

    onSubmit?.({ answersById, questions: actionable, runId, profileId });
    setSubmitted(true);
  };

  return (
    <Card category="system" className="w-full border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10">
      <div className="space-y-3 text-xs">
        <h4 className="font-semibold inline-flex items-center gap-2">
          <HelpCircle className="w-4 h-4 text-amber-700 dark:text-amber-300" />
          <span className="text-amber-800 dark:text-amber-200">Blocking Questions</span>
        </h4>

        {/* Display-only questions (no bind_to — informational) */}
        {displayOnly.length > 0 && (
          <ul className="list-disc list-inside space-y-1 text-[var(--text-secondary)]">
            {displayOnly.map((q, idx) => (
              <li key={questionKey(q, idx)}>{q.question}</li>
            ))}
          </ul>
        )}

        {/* Actionable questions (have bind_to — interactive) */}
        {actionable.map((q) => {
          const key = questionKey(q, questions.indexOf(q));
          return (
            <div key={key} className="rounded-lg border border-amber-200 dark:border-amber-700 p-2 space-y-1">
              <p className="font-medium text-[var(--text-primary)]">{q.question}</p>
              {q.why_needed && (
                <p className="text-[11px] text-[var(--text-muted)] italic">{q.why_needed}</p>
              )}
              <QuestionInput
                question={q}
                value={answers[key] || ''}
                onChange={(val) => setAnswer(key, val)}
                disabled={submitted}
              />
            </div>
          );
        })}

        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}

        {actionable.length > 0 && (
          <div className="flex justify-end">
            <Button
              variant={submitted ? 'secondary' : 'primary'}
              className="text-xs"
              disabled={submitted}
              onClick={handleSubmit}
            >
              {submitted ? 'Submitted' : 'Submit & Resume'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
