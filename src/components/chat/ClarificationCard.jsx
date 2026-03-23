import React, { useState } from 'react';
import { MessageCircleQuestion, Send, SkipForward } from 'lucide-react';
import { Card, Button } from '../ui';

/**
 * ClarificationCard — shown before task execution when the user's request is vague.
 * Renders structured clarification questions (single_select, multi_select, confirm, free_text),
 * plus "Answer & Proceed" and "Skip" buttons.
 *
 * @param {object} props
 * @param {object} props.payload - { questions: Array<string|QuestionObject>, original_instruction: string }
 * @param {function} props.onSubmit - Called with structured answers when user submits
 * @param {function} props.onSkip - Called when user skips clarification
 */
export default function ClarificationCard({ payload, onSubmit, onSkip }) {
  const rawQuestions = Array.isArray(payload?.questions) ? payload.questions : [];
  // Normalize: support both string[] (legacy) and object[] (structured)
  const questions = rawQuestions.map((q, i) =>
    typeof q === 'string'
      ? { question: q, question_zh: q, type: 'free_text', options: [], field: `q${i}` }
      : { ...q, options: q.options || [], field: q.field || `q${i}` }
  );

  const [answers, setAnswers] = useState(() => questions.map((q) =>
    q.type === 'multi_select' ? [] : ''
  ));
  const [submitted, setSubmitted] = useState(false);
  const [skipped, setSkipped] = useState(false);

  if (questions.length === 0) return null;

  const handleChange = (idx, value) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  };

  const anyFilled = answers.some((v) =>
    Array.isArray(v) ? v.length > 0 : (typeof v === 'string' ? v.trim().length > 0 : !!v)
  );

  const handleSubmit = () => {
    setSubmitted(true);
    // Return structured answers
    const structured = questions.map((q, i) => ({
      field: q.field,
      value: answers[i],
      type: q.type,
      question: q.question_zh || q.question,
    }));
    onSubmit?.(structured);
  };

  const handleSkip = () => {
    setSkipped(true);
    onSkip?.();
  };

  if (submitted) {
    return (
      <Card className="w-full border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10">
        <p className="text-xs text-green-700 dark:text-green-300">
          Got it! Re-planning with your preferences...
        </p>
      </Card>
    );
  }

  if (skipped) {
    return (
      <Card className="w-full border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Skipped clarification. Proceeding with default plan.
        </p>
      </Card>
    );
  }

  return (
    <Card className="w-full border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10">
      <div className="space-y-4 text-xs">
        <h4 className="font-semibold inline-flex items-center gap-2">
          <MessageCircleQuestion className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          Quick Questions Before I Start
        </h4>
        <p className="text-slate-600 dark:text-slate-300">
          Your request is broad — a few details will help me deliver exactly what you need.
        </p>

        <div className="space-y-4">
          {questions.map((q, idx) => (
            <QuestionRenderer
              key={idx}
              index={idx}
              question={q}
              value={answers[idx]}
              onChange={(val) => handleChange(idx, val)}
            />
          ))}
        </div>

        <div className="flex gap-2 pt-1">
          <Button
            variant="primary"
            className="text-xs"
            onClick={handleSubmit}
            disabled={!anyFilled}
          >
            <Send className="w-3 h-3 mr-1" />
            Answer &amp; Proceed
          </Button>
          <Button
            variant="ghost"
            className="text-xs text-slate-500"
            onClick={handleSkip}
          >
            <SkipForward className="w-3 h-3 mr-1" />
            Skip — Just Do It
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── Question Type Renderers ─────────────────────────────────────────────────

function QuestionRenderer({ index, question, value, onChange }) {
  const label = question.question_zh || question.question;

  return (
    <div className="space-y-1.5">
      <p className="text-slate-700 dark:text-slate-200 font-medium">
        {index + 1}. {label}
      </p>
      {question.type === 'single_select' && (
        <SingleSelectInput question={question} value={value} onChange={onChange} />
      )}
      {question.type === 'multi_select' && (
        <MultiSelectInput question={question} value={value} onChange={onChange} />
      )}
      {question.type === 'confirm' && (
        <ConfirmInput value={value} onChange={onChange} />
      )}
      {(question.type === 'free_text' || !question.type) && (
        <FreeTextInput value={value} onChange={onChange} />
      )}
    </div>
  );
}

function SingleSelectInput({ question, value, onChange }) {
  const [isOther, setIsOther] = useState(false);
  const [otherText, setOtherText] = useState('');

  const selectOption = (opt) => {
    setIsOther(false);
    onChange(opt);
  };

  const selectOther = () => {
    setIsOther(true);
    onChange(otherText);
  };

  return (
    <div className="space-y-1 pl-4">
      {question.options.map((opt, i) => (
        <label key={i} className="flex items-center gap-2 cursor-pointer group">
          <input
            type="radio"
            name={question.field}
            checked={value === opt && !isOther}
            onChange={() => selectOption(opt)}
            className="w-3.5 h-3.5 text-blue-600 border-slate-300 dark:border-slate-600 focus:ring-blue-500"
          />
          <span className="text-slate-700 dark:text-slate-300 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
            {opt}
          </span>
        </label>
      ))}
      <label className="flex items-center gap-2 cursor-pointer group">
        <input
          type="radio"
          name={question.field}
          checked={isOther}
          onChange={selectOther}
          className="w-3.5 h-3.5 text-blue-600 border-slate-300 dark:border-slate-600 focus:ring-blue-500"
        />
        <span className="text-slate-500 dark:text-slate-400">Other:</span>
        {isOther && (
          <input
            type="text"
            value={otherText}
            onChange={(e) => { setOtherText(e.target.value); onChange(e.target.value); }}
            autoFocus
            placeholder="Type your answer..."
            className="flex-1 border border-blue-300 dark:border-blue-700 rounded px-2 py-0.5 text-xs bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        )}
      </label>
    </div>
  );
}

function MultiSelectInput({ question, value, onChange }) {
  const selected = Array.isArray(value) ? value : [];
  const [otherChecked, setOtherChecked] = useState(false);
  const [otherText, setOtherText] = useState('');

  const toggleOption = (opt) => {
    const next = selected.includes(opt)
      ? selected.filter((v) => v !== opt)
      : [...selected, opt];
    onChange(next);
  };

  const toggleOther = () => {
    if (otherChecked) {
      setOtherChecked(false);
      onChange(selected.filter((v) => v !== otherText));
    } else {
      setOtherChecked(true);
      if (otherText) onChange([...selected, otherText]);
    }
  };

  const updateOtherText = (text) => {
    const prev = otherText;
    setOtherText(text);
    const filtered = selected.filter((v) => v !== prev);
    if (text) onChange([...filtered, text]);
    else onChange(filtered);
  };

  return (
    <div className="space-y-1 pl-4">
      <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-1">Select all that apply</p>
      {question.options.map((opt, i) => (
        <label key={i} className="flex items-center gap-2 cursor-pointer group">
          <input
            type="checkbox"
            checked={selected.includes(opt)}
            onChange={() => toggleOption(opt)}
            className="w-3.5 h-3.5 rounded text-blue-600 border-slate-300 dark:border-slate-600 focus:ring-blue-500"
          />
          <span className="text-slate-700 dark:text-slate-300 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
            {opt}
          </span>
        </label>
      ))}
      <label className="flex items-center gap-2 cursor-pointer group">
        <input
          type="checkbox"
          checked={otherChecked}
          onChange={toggleOther}
          className="w-3.5 h-3.5 rounded text-blue-600 border-slate-300 dark:border-slate-600 focus:ring-blue-500"
        />
        <span className="text-slate-500 dark:text-slate-400">Other:</span>
        {otherChecked && (
          <input
            type="text"
            value={otherText}
            onChange={(e) => updateOtherText(e.target.value)}
            autoFocus
            placeholder="Type your answer..."
            className="flex-1 border border-blue-300 dark:border-blue-700 rounded px-2 py-0.5 text-xs bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        )}
      </label>
    </div>
  );
}

function ConfirmInput({ value, onChange }) {
  return (
    <div className="flex gap-2 pl-4">
      <button
        type="button"
        onClick={() => onChange('yes')}
        className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
          value === 'yes'
            ? 'bg-blue-600 text-white'
            : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-blue-100 dark:hover:bg-blue-900/40'
        }`}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={() => onChange('no')}
        className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
          value === 'no'
            ? 'bg-slate-600 text-white'
            : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
        }`}
      >
        No
      </button>
    </div>
  );
}

function FreeTextInput({ value, onChange }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Your answer (optional)..."
      className="w-full border border-blue-300 dark:border-blue-700 rounded px-2 py-1 text-xs bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
    />
  );
}
