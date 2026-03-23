import React, { memo, useState, useMemo } from 'react';
import { Brain, FileText, Loader2, Paperclip, Send, Square, Table2, X } from 'lucide-react';
import { CHAT_ATTACHMENT_ACCEPT, formatAttachmentSize } from '../../services/chatAttachmentService';

const STATUS_TONE_CLASSES = {
  neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  info: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300',
};

const SLASH_COMMANDS = [
  { cmd: '/think', desc: 'Force full thinking mode for this message' },
  { cmd: '/think light', desc: 'Force lightweight thinking mode' },
  { cmd: '/ralph-loop', desc: 'Start Ralph Loop autonomous task execution' },
  { cmd: '/ralph-stop', desc: 'Stop a running Ralph Loop' },
  { cmd: '/forecast', desc: 'Run demand forecast on uploaded data' },
  { cmd: '/plan', desc: 'Generate replenishment plan' },
  { cmd: '/workflowA', desc: 'Run full Workflow A pipeline' },
  { cmd: '/macro-oracle', desc: 'Check macro supply chain signals' },
  { cmd: '/email', desc: 'Extract tasks from email content' },
  { cmd: '/transcript', desc: 'Extract tasks from meeting transcript' },
  { cmd: '/reuse off', desc: 'Disable dataset reuse' },
  { cmd: '/retrain', desc: 'Force model retrain' },
];

function ChatComposer({
  input,
  onInputChange,
  onKeyDown,
  onSubmit,
  textareaRef,
  fileInputRef,
  onFileInputChange,
  onFilePicker,
  isTyping,
  isUploading,
  uploadStatusText,
  isDragOver,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  pendingAttachments = [],
  onRemoveAttachment,
  status = null,
  variant = 'default',
  thinkingEnabled = false,
  onToggleThinkingEnabled,
  onStopGeneration,
}) {
  const isAIEmployeeVariant = variant === 'ai_employee';
  const statusTone = STATUS_TONE_CLASSES[status?.tone || 'neutral'] || STATUS_TONE_CLASSES.neutral;
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Slash command matching
  const slashMatches = useMemo(() => {
    const trimmed = (input || '').trim();
    if (!trimmed.startsWith('/')) return [];
    // Only match if input is just the command (no args yet, or still typing command portion)
    const cmdPart = trimmed.split(/\s/)[0].toLowerCase();
    if (cmdPart === '/') return SLASH_COMMANDS; // show all when just "/"
    return SLASH_COMMANDS.filter(s => s.cmd.toLowerCase().startsWith(cmdPart) && s.cmd.toLowerCase() !== cmdPart);
  }, [input]);

  const showSlashMenu = slashMatches.length > 0;
  const selectedMatchIdx = Math.min(selectedIdx, Math.max(slashMatches.length - 1, 0));
  const canSubmit = Boolean(String(input || '').trim()) || pendingAttachments.length > 0;

  const handleSlashSelect = (cmd) => {
    onInputChange({ target: { value: cmd + ' ' } });
    textareaRef.current?.focus();
  };

  const renderAttachmentChip = (attachment) => {
    const isSpreadsheet = attachment?.kind === 'spreadsheet';
    const Icon = isSpreadsheet ? Table2 : FileText;
    const secondary = [
      attachment?.kind,
      formatAttachmentSize(attachment?.size_bytes),
    ].filter(Boolean).join(' • ');

    return (
      <div
        key={attachment.id}
        className={`flex min-w-0 items-center gap-3 rounded-2xl border px-3 py-2 ${
          isAIEmployeeVariant
            ? 'bg-white/96 shadow-sm dark:bg-slate-900/90'
            : 'bg-slate-50 dark:bg-slate-900/60'
        }`}
        style={{ borderColor: 'rgba(148, 163, 184, 0.28)' }}
      >
        <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl ${isSpreadsheet ? 'bg-emerald-500 text-white' : 'bg-blue-500 text-white'}`}>
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {attachment.file_name}
          </p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">
            {secondary}
          </p>
        </div>
        <button
          type="button"
          className="rounded-full p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          onClick={() => onRemoveAttachment?.(attachment.id)}
          aria-label={`Remove ${attachment.file_name}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  };

  // Intercept arrow keys and Enter for slash menu navigation
  const handleKeyDownWrapper = (e) => {
    if (showSlashMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(i => Math.min(i + 1, slashMatches.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        handleSlashSelect(slashMatches[selectedMatchIdx].cmd);
        setSelectedIdx(0);
        return;
      }
      if (e.key === 'Escape') {
        // Let default handle
      }
    }
    if (e.key === 'Escape' && isTyping && onStopGeneration) {
      e.preventDefault();
      onStopGeneration();
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div
      className={`sticky bottom-0 z-10 transition-colors ${
        isAIEmployeeVariant
          ? `px-4 pb-4 pt-2 sm:px-6 sm:pb-6 ${
              isDragOver ? 'bg-blue-50/70 dark:bg-blue-950/20' : 'bg-transparent'
            }`
          : `border-t border-slate-200/70 bg-white/95 px-4 py-3 backdrop-blur dark:border-slate-700/60 dark:bg-slate-900/92 ${
              isDragOver ? 'bg-blue-50 dark:bg-blue-950/40' : ''
            }`
      }`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={CHAT_ATTACHMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={onFileInputChange}
      />

      <form onSubmit={onSubmit} className={`mx-auto ${isAIEmployeeVariant ? 'max-w-3xl' : 'max-w-4xl'}`}>
        {(status?.text || (isUploading && uploadStatusText)) ? (
          <div className="mb-2 flex items-center">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium ${statusTone}`}
            >
              {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {isUploading ? uploadStatusText || 'Processing...' : status?.text}
            </span>
          </div>
        ) : null}

        {typeof onToggleThinkingEnabled === 'function' ? (
          <div className="mb-2 flex items-center justify-end">
            <button
              type="button"
              onClick={onToggleThinkingEnabled}
              disabled={isTyping || isUploading}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                thinkingEnabled
                  ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                  : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
              }`}
              title={thinkingEnabled ? 'Thinking mode is forced on for this conversation' : 'Thinking mode follows automatic routing for this conversation'}
            >
              <Brain className="h-3.5 w-3.5" />
              <span>{thinkingEnabled ? 'Thinking On' : 'Thinking Auto'}</span>
            </button>
          </div>
        ) : null}

        {/* Slash command autocomplete menu */}
        {showSlashMenu && (
          <div className="mb-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800">
            {slashMatches.map((s, i) => (
              <button
                key={s.cmd}
                type="button"
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                  i === selectedMatchIdx
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                    : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700/50'
                }`}
                onMouseEnter={() => setSelectedIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); handleSlashSelect(s.cmd); setSelectedIdx(0); }}
              >
                <span className="font-mono font-semibold">{s.cmd}</span>
                <span className="text-xs text-slate-400 dark:text-slate-500">{s.desc}</span>
              </button>
            ))}
          </div>
        )}

        <div
          className={`relative transition-shadow ${
            isAIEmployeeVariant
              ? 'rounded-[28px] border border-black/8 bg-white/94 px-1 py-1 shadow-[0_24px_60px_rgba(15,23,42,0.08)] backdrop-blur dark:border-white/10 dark:bg-[#171717]/92'
              : 'rounded-2xl border border-slate-200 bg-white shadow-sm focus-within:ring-2 focus-within:ring-blue-500/40 dark:border-slate-700 dark:bg-slate-800'
          }`}
        >
          {pendingAttachments.length > 0 ? (
            <div className={`flex flex-wrap gap-2 px-3 pt-3 ${isAIEmployeeVariant ? 'pb-1' : 'pb-2'}`}>
              {pendingAttachments.map(renderAttachmentChip)}
            </div>
          ) : null}

          <div className={`absolute left-2.5 flex items-center gap-0.5 ${
            isAIEmployeeVariant ? 'bottom-2.5' : 'top-2.5'
          }`}>
            <button
              type="button"
              className={`p-2 text-slate-500 transition-colors disabled:opacity-50 ${
                isAIEmployeeVariant
                  ? 'rounded-full hover:bg-slate-100 dark:hover:bg-slate-800'
                  : 'rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700'
              }`}
              onClick={onFilePicker}
              disabled={isUploading}
              data-testid="attach-button"
              title="Attach files"
            >
              {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
            </button>
          </div>

          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={onInputChange}
            onKeyDown={handleKeyDownWrapper}
            disabled={isTyping || isUploading}
            placeholder={isDragOver ? 'Drop files to attach...' : isAIEmployeeVariant ? 'Message your worker' : 'Message Decision-Intelligence'}
            className={`w-full resize-none overflow-hidden bg-transparent text-sm outline-none ${
              isAIEmployeeVariant
                ? 'rounded-[26px] pl-[72px] pr-16 py-4 text-[15px] leading-6 text-slate-800 dark:text-slate-100 placeholder:text-slate-400'
                : 'pl-12 rounded-2xl pr-12 py-3'
            }`}
            style={{ minHeight: '52px', maxHeight: '180px' }}
          />

          {isTyping && onStopGeneration ? (
            <button
              type="button"
              onClick={onStopGeneration}
              className={`absolute right-2.5 p-2 text-white transition-colors ${
                isAIEmployeeVariant
                  ? 'bottom-2.5 rounded-full bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700'
                  : 'top-2.5 rounded-lg bg-red-600 hover:bg-red-700'
              }`}
              title="Stop generation (Esc)"
            >
              <Square className="w-4 h-4 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={isTyping || isUploading || !canSubmit}
              className={`absolute right-2.5 p-2 text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                isAIEmployeeVariant
                  ? 'bottom-2.5 rounded-full bg-slate-900 hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'
                  : 'top-2.5 rounded-lg bg-blue-600 hover:bg-blue-700'
              }`}
              title="Send"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </form>

      {isAIEmployeeVariant ? null : (
        <div className="mx-auto mt-2 flex max-w-4xl items-center gap-2 text-[11px] text-slate-500">
          {isUploading ? (
            <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-300">
              <Loader2 className="w-3 h-3 animate-spin" />
              {uploadStatusText || 'Processing...'}
            </span>
          ) : (
            <span>Attach spreadsheets or documents (max 50MB total)</span>
          )}
          <span className="text-slate-300">•</span>
          <span>Commands: /think, /forecast, /plan, /workflowA, /ralph-loop, /reuse off, /retrain</span>
          <span className="text-slate-300">•</span>
          <span>Enter to send, Shift+Enter for newline</span>
        </div>
      )}
    </div>
  );
}

export default memo(ChatComposer);
