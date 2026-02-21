import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatMessageBubble from './ChatMessageBubble';
import EmptyChatState from './EmptyChatState';
import TypingIndicator from './TypingIndicator';
import JumpToLatestButton from './JumpToLatestButton';

function ChatSkeleton() {
  return (
    <div className="p-6 space-y-4 animate-pulse">
      {Array.from({ length: 4 }).map((_, idx) => (
        <div key={idx} className={`flex ${idx % 2 ? 'justify-end' : 'justify-start'}`}>
          <div className={`h-16 rounded-2xl ${idx % 2 ? 'w-64 bg-blue-100/70' : 'w-80 bg-slate-200 dark:bg-slate-800'}`} />
        </div>
      ))}
    </div>
  );
}

function ChatThread({
  messages,
  isTyping,
  streamingContent,
  formatTime,
  renderSpecialMessage,
  quickPrompts,
  onSelectPrompt,
  showInitialEmptyState,
  isLoading
}) {
  const scrollRef = useRef(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  const hasMessages = Array.isArray(messages) && messages.length > 0;

  const checkPinned = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
  }, []);

  const handleScroll = useCallback(() => {
    setIsPinnedToBottom(checkPinned());
  }, [checkPinned]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isPinnedToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingContent, isTyping, isPinnedToBottom]);

  const typingMessage = useMemo(() => {
    if (!isTyping) return null;
    return streamingContent
      ? { role: 'ai', content: streamingContent, timestamp: new Date().toISOString() }
      : null;
  }, [isTyping, streamingContent]);

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <div ref={scrollRef} className="h-full overflow-y-auto chat-scrollbar px-4 md:px-6 py-5 space-y-4">
        {isLoading ? (
          <ChatSkeleton />
        ) : showInitialEmptyState ? (
          <EmptyChatState quickPrompts={quickPrompts} onSelectPrompt={onSelectPrompt} />
        ) : (
          <>
            {hasMessages && messages.map((message, idx) => (
              <ChatMessageBubble
                key={`${message.timestamp || idx}_${idx}`}
                message={message}
                renderSpecialMessage={renderSpecialMessage}
                timestampText={message.type ? '' : formatTime(message.timestamp)}
              />
            ))}
            {isTyping ? (
              <div className="w-full flex justify-start">
                {typingMessage ? (
                  <ChatMessageBubble
                    message={typingMessage}
                    renderSpecialMessage={renderSpecialMessage}
                    timestampText=""
                  />
                ) : (
                  <div className="rounded-2xl rounded-bl-md border border-slate-200/70 dark:border-slate-700/70 bg-white dark:bg-slate-800 px-4 py-2.5 shadow-sm">
                    <TypingIndicator />
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      {!isPinnedToBottom && hasMessages ? (
        <JumpToLatestButton
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            setIsPinnedToBottom(true);
          }}
        />
      ) : null}
    </div>
  );
}

export default memo(ChatThread);
