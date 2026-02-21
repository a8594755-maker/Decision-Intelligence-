import React, { memo } from 'react';
import { Loader2, Paperclip, Send } from 'lucide-react';

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
  onDrop
}) {
  return (
    <div
      className={`sticky bottom-0 z-10 border-t border-slate-200/70 dark:border-slate-700/60 bg-white/95 dark:bg-slate-900/92 backdrop-blur px-4 md:px-6 py-3 transition-colors ${
        isDragOver ? 'bg-blue-50 dark:bg-blue-950/40' : ''
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

      <form onSubmit={onSubmit} className="mx-auto max-w-4xl">
        <div className="relative rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm focus-within:ring-2 focus-within:ring-blue-500/40 transition-shadow">
          <button
            type="button"
            className="absolute left-2.5 top-2.5 p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
            onClick={onFilePicker}
            disabled={isTyping || isUploading}
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
            placeholder={isDragOver ? 'Drop CSV/XLSX to upload...' : 'Message Decision-Intelligence'}
            className="w-full resize-none overflow-hidden rounded-2xl bg-transparent pl-12 pr-12 py-3 text-sm outline-none"
            style={{ minHeight: '52px', maxHeight: '180px' }}
          />

          <button
            type="submit"
            disabled={isTyping || isUploading || !String(input || '').trim()}
            className="absolute right-2.5 top-2.5 p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Send"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </form>

      <div className="mx-auto max-w-4xl mt-2 flex items-center gap-2 text-[11px] text-slate-500">
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
    </div>
  );
}

export default memo(ChatComposer);
