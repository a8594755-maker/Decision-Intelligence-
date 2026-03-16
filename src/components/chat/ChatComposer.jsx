import React, { memo } from 'react';
import { Loader2, Paperclip, Send } from 'lucide-react';

const STATUS_TONE_CLASSES = {
  neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  info: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300',
};

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
  status = null,
  variant = 'default',
}) {
  const isAIEmployeeVariant = variant === 'ai_employee';
  const statusTone = STATUS_TONE_CLASSES[status?.tone || 'neutral'] || STATUS_TONE_CLASSES.neutral;

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
        accept=".csv,.xlsx,.xls"
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

        <div
          className={`relative transition-shadow ${
            isAIEmployeeVariant
              ? 'rounded-[28px] border border-black/8 bg-white/94 px-1 py-1 shadow-[0_24px_60px_rgba(15,23,42,0.08)] backdrop-blur dark:border-white/10 dark:bg-[#171717]/92'
              : 'rounded-2xl border border-slate-200 bg-white shadow-sm focus-within:ring-2 focus-within:ring-blue-500/40 dark:border-slate-700 dark:bg-slate-800'
          }`}
        >
          <button
            type="button"
            className={`absolute left-2.5 p-2 text-slate-500 transition-colors disabled:opacity-50 ${
              isAIEmployeeVariant
                ? 'bottom-2.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800'
                : 'top-2.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700'
            }`}
            onClick={onFilePicker}
            disabled={isUploading}
            title="Upload CSV/XLSX"
          >
            {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            disabled={isTyping || isUploading}
            placeholder={isDragOver ? 'Drop CSV/XLSX to upload...' : isAIEmployeeVariant ? 'Message your worker' : 'Message Decision-Intelligence'}
            className={`w-full resize-none overflow-hidden bg-transparent text-sm outline-none ${
              isAIEmployeeVariant
                ? 'rounded-[26px] pl-12 pr-16 py-4 text-[15px] leading-6 text-slate-800 dark:text-slate-100 placeholder:text-slate-400'
                : 'rounded-2xl pl-12 pr-12 py-3'
            }`}
            style={{ minHeight: '52px', maxHeight: '180px' }}
          />

          <button
            type="submit"
            disabled={isTyping || isUploading || !String(input || '').trim()}
            className={`absolute right-2.5 p-2 text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              isAIEmployeeVariant
                ? 'bottom-2.5 rounded-full bg-slate-900 hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'
                : 'top-2.5 rounded-lg bg-blue-600 hover:bg-blue-700'
            }`}
            title="Send"
          >
            <Send className="w-4 h-4" />
          </button>
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
            <span>Attach CSV/XLSX (max 50MB)</span>
          )}
          <span className="text-slate-300">•</span>
          <span>Commands: /forecast, /plan, /workflowA, /reuse off, /retrain</span>
          <span className="text-slate-300">•</span>
          <span>Enter to send, Shift+Enter for newline</span>
        </div>
      )}
    </div>
  );
}

export default memo(ChatComposer);
