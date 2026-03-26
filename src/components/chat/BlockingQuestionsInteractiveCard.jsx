import React, { useState } from 'react';
import { HelpCircle, Send } from 'lucide-react';
import { Card, Button } from '../ui';

export default function BlockingQuestionsInteractiveCard({ payload, onSubmit }) {
  const questions = Array.isArray(payload?.questions) ? payload.questions.slice(0, 2) : [];
  const [answers, setAnswers] = useState(() =>
    Object.fromEntries(questions.map((_, idx) => [String(idx), '']))
  );
  const [submitted, setSubmitted] = useState(false);

  if (questions.length === 0) return null;

  const handleChange = (idx, value) => {
    setAnswers((prev) => ({ ...prev, [String(idx)]: value }));
  };

  const allFilled = Object.values(answers).every((v) => String(v).trim().length > 0);

  const handleSubmit = () => {
    if (!allFilled) return;
    setSubmitted(true);
    onSubmit?.(answers);
  };

  return (
    <Card category="system" className="w-full border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10">
      <div className="space-y-3 text-xs">
        <h4 className="font-semibold inline-flex items-center gap-2">
          <HelpCircle className="w-4 h-4 text-amber-700 dark:text-amber-300" />
          Action Required — Blocking Questions
        </h4>
        {submitted ? (
          <p className="text-green-700 dark:text-green-300">Answers submitted. Resuming workflow...</p>
        ) : (
          <div className="space-y-2">
            {questions.map((question, idx) => (
              <div key={idx} className="space-y-1">
                <p className="text-[var(--text-secondary)]">
                  {typeof question === 'string' ? question : question?.question || JSON.stringify(question)}
                </p>
                <input
                  type="text"
                  value={answers[String(idx)]}
                  onChange={(e) => handleChange(idx, e.target.value)}
                  placeholder="Your answer..."
                  className="w-full border border-amber-300 dark:border-amber-700 rounded px-2 py-1 text-xs bg-[var(--surface-card)]"
                />
              </div>
            ))}
            <Button
              variant="primary"
              className="text-xs"
              onClick={handleSubmit}
              disabled={!allFilled}
            >
              <Send className="w-3 h-3 mr-1" />
              Submit Answers &amp; Continue
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
