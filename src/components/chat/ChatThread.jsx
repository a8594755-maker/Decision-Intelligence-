import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatMessageBubble from './ChatMessageBubble';
import EmptyChatState from './EmptyChatState';
import TypingIndicator from './TypingIndicator';
import JumpToLatestButton from './JumpToLatestButton';
import ThinkingStepsDisplay from './ThinkingStepsDisplay';

function ChatSkeleton() {
  return (
    <div className="p-6 space-y-4 animate-pulse">
      {Array.from({ length: 4 }).map((_, idx) => (
        <div key={idx} className={`flex ${idx % 2 ? 'justify-end' : 'justify-start'}`}>
          <div className={`h-16 rounded-2xl ${idx % 2 ? 'w-64 bg-[var(--brand-50)]' : 'w-80 bg-[var(--surface-subtle)]'}`} />
        </div>
      ))}
    </div>
  );
}

function ChatThread({
  messages,
  isTyping,
  streamingContent,
  streamingToolCalls = [],
  thinkingSteps,
  formatTime,
  renderSpecialMessage,
  quickPrompts,
  onSelectPrompt,
  showInitialEmptyState,
  isLoading,
  variant = 'default',
  thinkingPanelActive = false,
  onOpenThinkingPanel,
}) {
  const scrollRef = useRef(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const isAIEmployeeVariant = variant === 'ai_employee';

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
  }, [messages, streamingContent, thinkingSteps, isTyping, isPinnedToBottom]);

  const typingMessage = useMemo(() => {
    if (!isTyping) return null;
    return streamingContent
      ? { role: 'ai', content: streamingContent, timestamp: new Date().toISOString() }
      : null;
  }, [isTyping, streamingContent]);

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <div
        ref={scrollRef}
        className={`h-full overflow-y-auto chat-scrollbar ${
          isAIEmployeeVariant ? 'px-3 py-6 sm:px-6 sm:py-8' : 'px-4 py-5 md:px-6'
        }`}
      >
        {isLoading ? (
          <ChatSkeleton />
        ) : showInitialEmptyState ? (
          <div className={isAIEmployeeVariant ? 'mx-auto max-w-4xl' : ''}>
            <EmptyChatState quickPrompts={quickPrompts} onSelectPrompt={onSelectPrompt} variant={variant} />
          </div>
        ) : (
          <div className={isAIEmployeeVariant ? 'mx-auto w-full max-w-3xl space-y-6' : 'space-y-4'}>
            {hasMessages && messages.map((message, idx) => (
              <div key={`${message.timestamp || idx}_${idx}`} data-msg-idx={idx}>
                <ChatMessageBubble
                  message={message}
                  renderSpecialMessage={renderSpecialMessage}
                  timestampText={message.type ? '' : formatTime(message.timestamp)}
                  variant={variant}
                />
              </div>
            ))}
            {thinkingSteps?.length > 0 && isTyping && (
              <ThinkingStepsDisplay
                steps={thinkingSteps}
                mode="inline"
                onOpenPanel={onOpenThinkingPanel}
              />
            )}
            {isTyping ? (
              <div className="w-full space-y-2">
                {typingMessage ? (
                  <div className="flex justify-start">
                    <ChatMessageBubble
                      message={typingMessage}
                      renderSpecialMessage={renderSpecialMessage}
                      timestampText=""
                      variant={variant}
                    />
                  </div>
                ) : (
                  <div className="px-0 py-1 text-[var(--text-primary)]">
                    <TypingIndicator />
                  </div>
                )}
                {/* Streaming tool call status bar */}
                {streamingToolCalls.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-1">
                    {streamingToolCalls.map((tc, i) => (
                      <span
                        key={`${tc.name}-${i}`}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          tc.status === 'running'
                            ? 'bg-[var(--status-info-bg)] text-[var(--status-info-text)] animate-pulse'
                            : tc.status === 'done'
                              ? 'bg-[var(--status-success-bg)] text-[var(--status-success-text)]'
                              : 'bg-[var(--status-danger-bg)] text-[var(--status-danger-text)]'
                        }`}
                      >
                        {tc.status === 'running' ? '⏳' : tc.status === 'done' ? '✅' : '❌'}
                        {tc.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
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
