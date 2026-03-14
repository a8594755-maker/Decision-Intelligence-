import React, { useState } from 'react';
import { MessageCircleQuestion, Send, SkipForward } from 'lucide-react';
import { Card, Button } from '../ui';

/**
 * ClarificationCard — shown before task execution when the user's request is vague.
 * Renders clarification questions with text inputs, plus "Answer & Proceed" and "Skip" buttons.
 *
 * @param {object} props
 * @param {object} props.payload - { questions: string[], original_instruction: string }
 * @param {function} props.onSubmit - Called with answers array when user submits
 * @param {function} props.onSkip - Called when user skips clarification
 */
export default function ClarificationCard({ payload, onSubmit, onSkip }) {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const [answers, setAnswers] = useState(() => questions.map(() => ''));
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

  const anyFilled = answers.some((v) => v.trim().length > 0);

  const handleSubmit = () => {
    setSubmitted(true);
    onSubmit?.(answers);
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
      <div className="space-y-3 text-xs">
        <h4 className="font-semibold inline-flex items-center gap-2">
          <MessageCircleQuestion className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          Quick Questions Before I Start
        </h4>
        <p className="text-slate-600 dark:text-slate-300">
          Your request is broad — a few details will help me deliver exactly what you need.
        </p>

        <div className="space-y-2">
          {questions.map((question, idx) => (
            <div key={idx} className="space-y-1">
              <p className="text-slate-700 dark:text-slate-200 font-medium">
                {idx + 1}. {question}
              </p>
              <input
                type="text"
                value={answers[idx]}
                onChange={(e) => handleChange(idx, e.target.value)}
                placeholder="Your answer (optional)..."
                className="w-full border border-blue-300 dark:border-blue-700 rounded px-2 py-1 text-xs bg-white dark:bg-slate-800"
              />
            </div>
          ))}
        </div>

        <div className="flex gap-2">
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
