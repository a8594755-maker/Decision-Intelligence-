import React from 'react';
import { ArrowDown } from 'lucide-react';

export default function JumpToLatestButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-4 bottom-4 z-20 inline-flex items-center gap-1.5 rounded-full bg-slate-900 text-white text-xs px-3 py-1.5 shadow-lg hover:bg-slate-700 transition-colors"
    >
      <ArrowDown className="w-3.5 h-3.5" />
      Jump to latest
    </button>
  );
}
