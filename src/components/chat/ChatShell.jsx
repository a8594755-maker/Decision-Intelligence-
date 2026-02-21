import React from 'react';

export default function ChatShell({ sidebar, chat, canvas, className = '' }) {
  return (
    <div className={`h-full w-full flex flex-col md:flex-row gap-3 ${className}`}>
      <aside className="w-full md:w-[300px] lg:w-[320px] min-w-0 flex-shrink-0 md:h-full max-h-72 md:max-h-none">
        {sidebar}
      </aside>
      <section className="flex-1 min-w-0 flex gap-3">
        <div className="flex-1 min-w-0">{chat}</div>
        {canvas}
      </section>
    </div>
  );
}
