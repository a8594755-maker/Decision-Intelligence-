// ============================================
// Decision Support View - What-if AI Assistant
// Optimized: local-first conversations, rich context,
// markdown rendering, streaming, quick prompts
// ============================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot, Send, FileText, X, Loader2, Database,
  Sparkles, AlertTriangle, TrendingUp, Building2, Package
} from 'lucide-react';
import { Card, Button, Badge } from '../../components/ui';
import { supabase } from '../../services/supabaseClient';
import { streamChatWithAI } from '../../services/geminiAPI';

// ── localStorage helpers for local-first conversations ──
const STORAGE_KEY = 'smartops_conversations';

function loadLocalConversations(userId) {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}_${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveLocalConversations(userId, conversations) {
  try {
    localStorage.setItem(`${STORAGE_KEY}_${userId}`, JSON.stringify(conversations));
  } catch { /* quota exceeded – silently ignore */ }
}

// ── Quick-prompt suggestions ──
const QUICK_PROMPTS = [
  { icon: AlertTriangle, label: 'Top risk items', prompt: 'What are my top 5 highest-risk materials right now? Show their risk scores and recommended actions.' },
  { icon: TrendingUp, label: 'Stockout forecast', prompt: 'Which materials are most likely to stockout in the next 2 weeks? What actions should I take?' },
  { icon: Building2, label: 'Supplier performance', prompt: 'Summarize my supplier delivery performance. Which suppliers have the worst on-time delivery rates?' },
  { icon: Package, label: 'What-if comparison', prompt: 'Compare my recent what-if scenarios. Which action gives the best ROI?' },
];

// ── Markdown components for styled rendering ──
const markdownComponents = {
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-xs border-collapse border border-slate-300 dark:border-slate-600">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-slate-100 dark:bg-slate-700">{children}</thead>,
  th: ({ children }) => <th className="border border-slate-300 dark:border-slate-600 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-slate-300 dark:border-slate-600 px-2 py-1">{children}</td>,
  code: ({ inline, children, ...props }) => {
    if (inline) {
      return <code className="bg-slate-200 dark:bg-slate-600 px-1 py-0.5 rounded text-xs" {...props}>{children}</code>;
    }
    return (
      <pre className="bg-slate-900 text-slate-100 p-3 rounded-lg overflow-x-auto my-2 text-xs">
        <code {...props}>{children}</code>
      </pre>
    );
  },
  ul: ({ children }) => <ul className="list-disc list-inside space-y-1 my-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside space-y-1 my-1">{children}</ol>,
  p: ({ children }) => <p className="my-1">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  h1: ({ children }) => <h1 className="text-base font-bold mt-3 mb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-bold mt-2 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
};

// ── Build supply-chain context from DB ──
async function loadDomainContext(userId) {
  const ctx = { riskItems: [], suppliers: null, materials: null, whatIfRuns: [], deliveryStats: null };

  // Top risk items
  try {
    const { data } = await supabase
      .from('risk_score_results')
      .select('material_code, plant_id, p_stockout, impact_usd, score')
      .eq('user_id', userId)
      .order('score', { ascending: false })
      .limit(10);
    if (data) ctx.riskItems = data;
  } catch { /* table may not exist */ }

  // Supplier + material counts
  try {
    const [{ count: sCount }, { count: mCount }] = await Promise.all([
      supabase.from('suppliers').select('*', { count: 'exact', head: true }),
      supabase.from('materials').select('*', { count: 'exact', head: true }).eq('user_id', userId),
    ]);
    ctx.suppliers = sCount;
    ctx.materials = mCount;
  } catch { /* ignore */ }

  // Recent what-if runs
  try {
    const { data } = await supabase
      .from('what_if_runs')
      .select('material_code, plant_id, action_type, delta_p_stockout, delta_impact_usd, cost_usd, roi, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);
    if (data) ctx.whatIfRuns = data;
  } catch { /* table may not exist */ }

  // Delivery stats (last 30 days)
  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const { data } = await supabase
      .from('goods_receipts')
      .select('is_on_time')
      .eq('user_id', userId)
      .gte('actual_delivery_date', since.toISOString().split('T')[0]);
    if (data && data.length > 0) {
      const onTime = data.filter(r => r.is_on_time === true).length;
      ctx.deliveryStats = { total: data.length, onTimeRate: ((onTime / data.length) * 100).toFixed(1) };
    }
  } catch { /* ignore */ }

  return ctx;
}

function buildSystemPrompt(domainCtx, excelData) {
  let prompt = `You are **SmartOps Decision Assistant**, an expert supply-chain AI.
Answer in the same language the user writes in. Use Markdown formatting (tables, bold, lists) for clarity.
Be concise, data-driven, and actionable.\n\n`;

  prompt += `## Current Supply Chain State\n`;

  if (domainCtx.suppliers != null || domainCtx.materials != null) {
    prompt += `- **Suppliers**: ${domainCtx.suppliers ?? 'unknown'} | **Materials**: ${domainCtx.materials ?? 'unknown'}\n`;
  }

  if (domainCtx.deliveryStats) {
    prompt += `- **Delivery performance (30d)**: ${domainCtx.deliveryStats.total} receipts, ${domainCtx.deliveryStats.onTimeRate}% on-time\n`;
  }

  if (domainCtx.riskItems.length > 0) {
    prompt += `\n### Top Risk Items (by score)\n`;
    prompt += `| Material | Plant | P(stockout) | Impact USD | Score |\n|---|---|---|---|---|\n`;
    domainCtx.riskItems.forEach(r => {
      prompt += `| ${r.material_code} | ${r.plant_id} | ${(r.p_stockout * 100).toFixed(0)}% | $${Number(r.impact_usd).toLocaleString()} | ${Number(r.score).toFixed(0)} |\n`;
    });
  }

  if (domainCtx.whatIfRuns.length > 0) {
    prompt += `\n### Recent What-if Scenarios\n`;
    domainCtx.whatIfRuns.forEach(w => {
      prompt += `- **${w.action_type}** on ${w.material_code}/${w.plant_id}: ΔP(stockout)=${(w.delta_p_stockout * 100).toFixed(0)}%, ΔImpact=$${Number(w.delta_impact_usd).toLocaleString()}, Cost=$${Number(w.cost_usd).toLocaleString()}, ROI=${Number(w.roi).toFixed(1)}x\n`;
    });
  }

  if (excelData && excelData.length > 0) {
    prompt += `\n### User Uploaded Data (sample)\n\`\`\`json\n${JSON.stringify(excelData.slice(0, 3), null, 2)}\n\`\`\`\n`;
  }

  return prompt;
}

// ── Main Component ──
export default function DecisionSupportView({ excelData, user, addNotification }) {
  const [input, setInput] = useState('');
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [isTyping, setIsTyping] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);
  const [domainContext, setDomainContext] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversations, currentConversationId, streamingContent]);

  // Load domain context on mount
  useEffect(() => {
    if (!user?.id) return;
    setContextLoading(true);
    loadDomainContext(user.id)
      .then(ctx => setDomainContext(ctx))
      .catch(() => setDomainContext(null))
      .finally(() => setContextLoading(false));
  }, [user?.id]);

  // Load conversations: try Supabase first, fall back to localStorage
  useEffect(() => {
    if (!user?.id) return;
    let active = true;

    const load = async () => {
      // Try Supabase
      const { data, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false });

      if (active) {
        if (!error && data) {
          setConversations(data);
          if (data.length > 0 && !currentConversationId) {
            setCurrentConversationId(data[0].id);
          }
          // Sync to localStorage as backup
          saveLocalConversations(user.id, data);
        } else {
          // Supabase failed (404 / network) → load from localStorage
          console.warn('Conversations table unavailable, using local storage', error?.message);
          const local = loadLocalConversations(user.id);
          setConversations(local);
          if (local.length > 0 && !currentConversationId) {
            setCurrentConversationId(local[0].id);
          }
        }
      }
    };

    load();
    return () => { active = false; };
  }, [user?.id]);

  // Persist conversations to localStorage whenever they change
  useEffect(() => {
    if (user?.id && conversations.length > 0) {
      saveLocalConversations(user.id, conversations);
    }
  }, [conversations, user?.id]);

  // Get current conversation
  const currentConversation = conversations.find(c => c.id === currentConversationId);
  const currentMessages = currentConversation?.messages || [];

  // System prompt (memoized)
  const systemPrompt = useMemo(() => {
    if (!domainContext) return '';
    return buildSystemPrompt(domainContext, excelData);
  }, [domainContext, excelData]);

  // Create new conversation
  const handleNewConversation = useCallback(async () => {
    if (!user?.id) {
      addNotification?.("Please sign in before starting a new conversation.", "error");
      return;
    }
    setShowNewChatConfirm(false);

    const newConversation = {
      id: Date.now().toString(),
      user_id: user.id,
      title: 'New Conversation',
      messages: [{ role: 'ai', content: 'Hello! I\'m your **SmartOps Decision Assistant**. I have access to your supply chain data including risk scores, inventory, and supplier performance.\n\nHow can I help you today?' }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    setConversations(prev => [newConversation, ...prev]);
    setCurrentConversationId(newConversation.id);

    // Try to persist to Supabase (non-blocking)
    supabase.from('conversations').insert([newConversation]).then(({ error }) => {
      if (error) console.warn('Conversation saved locally only:', error.message);
    });

    addNotification?.("New conversation ready.", "success");
  }, [user?.id, addNotification]);

  // Delete conversation
  const handleDeleteConversation = useCallback(async (convId) => {
    if (!user?.id) return;

    // Remove locally first (optimistic)
    setConversations(prev => {
      const updated = prev.filter(c => c.id !== convId);
      if (convId === currentConversationId) {
        setCurrentConversationId(updated.length > 0 ? updated[0].id : null);
      }
      return updated;
    });

    // Try Supabase delete (non-blocking)
    supabase.from('conversations').delete().eq('id', convId).eq('user_id', user.id).then(({ error }) => {
      if (error) console.warn('Remote delete failed:', error.message);
    });
  }, [user?.id, currentConversationId]);

  // Send message with streaming
  const handleSend = useCallback(async (e) => {
    if (e) e.preventDefault();
    if (!input.trim() || !currentConversationId) return;

    const userMsg = { role: 'user', content: input, timestamp: new Date().toISOString() };
    const messageText = input;
    setInput('');
    setIsTyping(true);
    setStreamingContent('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Update messages immediately for UI
    const updatedMessages = [...currentMessages, userMsg];
    setConversations(prev => prev.map(c =>
      c.id === currentConversationId
        ? { ...c, messages: updatedMessages, updated_at: new Date().toISOString() }
        : c
    ));

    // Build conversation history for context (last 10 messages)
    const history = updatedMessages.slice(-10);

    // Call AI with streaming
    let fullResult = '';
    try {
      fullResult = await streamChatWithAI(
        messageText,
        history,
        systemPrompt,
        (chunk) => {
          setStreamingContent(prev => prev + chunk);
        }
      );
    } catch (error) {
      console.error("AI call failed:", error);
      fullResult = `❌ AI service temporarily unavailable\n\nError: ${error.message}\n\nPlease try again later or check your API key in Settings.`;
    }

    const aiMsg = { role: 'ai', content: fullResult, timestamp: new Date().toISOString() };
    const finalMessages = [...updatedMessages, aiMsg];

    // Update title based on first user message
    const newTitle = currentMessages.length <= 1 ? messageText.slice(0, 50) : currentConversation.title;

    const updatedConversation = {
      ...currentConversation,
      title: newTitle,
      messages: finalMessages,
      updated_at: new Date().toISOString()
    };

    // Update local state
    setConversations(prev => prev.map(c =>
      c.id === currentConversationId ? updatedConversation : c
    ));

    setStreamingContent('');
    setIsTyping(false);

    // Persist to Supabase (non-blocking)
    supabase.from('conversations').update({
      title: newTitle,
      messages: finalMessages,
      updated_at: new Date().toISOString()
    }).eq('id', currentConversationId).eq('user_id', user.id).then(({ error }) => {
      if (error) console.warn('Cloud save failed, kept locally:', error.message);
    });
  }, [input, currentConversationId, currentMessages, currentConversation, systemPrompt, user?.id]);

  // Handle quick prompt click
  const handleQuickPrompt = useCallback((prompt) => {
    setInput(prompt);
    // Auto-send after a tick so the UI updates
    setTimeout(() => {
      const fakeEvent = { preventDefault: () => {} };
      setInput(prompt);
    }, 50);
  }, []);

  // Handle textarea auto-resize + Enter/Shift+Enter
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  }, [handleSend]);

  const handleTextareaChange = useCallback((e) => {
    setInput(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }, []);

  // Format timestamp
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  // Context status indicator
  const contextBadge = useMemo(() => {
    if (contextLoading) return { text: 'Loading context...', color: 'bg-yellow-100 text-yellow-700' };
    if (!domainContext) return { text: 'No context', color: 'bg-slate-100 text-slate-500' };
    const parts = [];
    if (domainContext.riskItems.length > 0) parts.push(`${domainContext.riskItems.length} risks`);
    if (domainContext.suppliers) parts.push(`${domainContext.suppliers} suppliers`);
    if (domainContext.materials) parts.push(`${domainContext.materials} materials`);
    if (domainContext.whatIfRuns.length > 0) parts.push(`${domainContext.whatIfRuns.length} scenarios`);
    if (parts.length === 0) return { text: 'Context ready', color: 'bg-green-100 text-green-700' };
    return { text: parts.join(' | '), color: 'bg-green-100 text-green-700' };
  }, [domainContext, contextLoading]);

  return (
    <div className="h-[calc(100vh-140px)] flex flex-col md:flex-row gap-6 animate-fade-in">
      {/* Conversations Sidebar */}
      <Card className="md:w-80 w-full h-full max-h-[calc(100vh-180px)] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between border-b p-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Bot className="w-4 h-4" />
            Conversations
          </h3>
          <Button
            variant="primary"
            onClick={() => conversations.length > 0 ? setShowNewChatConfirm(true) : handleNewConversation()}
            className="px-3 py-1 text-xs"
          >
            + New
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y">
          {conversations.length === 0 ? (
            <div className="p-8 text-center">
              <Bot className="w-12 h-12 text-slate-300 mx-auto mb-3" />
              <p className="text-sm text-slate-400 mb-4">No conversations yet</p>
              <Button variant="primary" onClick={handleNewConversation} className="text-xs">
                Start Chatting
              </Button>
            </div>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                className={`p-3 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer transition group ${
                  currentConversationId === conv.id ? 'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-l-blue-600' : ''
                }`}
                onClick={() => setCurrentConversationId(conv.id)}
              >
                <div className="flex items-start justify-between mb-1">
                  <h4 className="font-medium text-sm line-clamp-1 flex-1">
                    {conv.title || 'New Conversation'}
                  </h4>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteConversation(conv.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition"
                  >
                    <X className="w-3 h-3 text-red-600" />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-400 line-clamp-1 flex-1">
                    {conv.messages[conv.messages.length - 1]?.content.slice(0, 40)}...
                  </p>
                  <span className="text-xs text-slate-400 ml-2">
                    {formatTime(conv.updated_at)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <Badge type="info">{conv.messages.length} msgs</Badge>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* Chat Area */}
      <Card className="flex-1 flex flex-col overflow-hidden p-0 h-full">
        {currentConversation ? (
          <>
            <div className="bg-slate-50 dark:bg-slate-800 border-b p-4 flex items-center justify-between">
              <div>
                <h3 className="font-semibold">{currentConversation.title}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <p className="text-xs text-slate-500">
                    {currentMessages.length} messages
                  </p>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${contextBadge.color}`}>
                    {contextBadge.text}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setShowNewChatConfirm(true)}
                className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition"
                title="New conversation"
              >
                <FileText className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
              {currentMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}>
                  <div className={`max-w-[85%] rounded-2xl p-3 md:p-4 ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100'
                  }`}>
                    {msg.role === 'user' ? (
                      <div className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</div>
                    ) : (
                      <div className="text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    )}
                    {msg.timestamp && (
                      <div className={`text-xs mt-2 ${msg.role === 'user' ? 'text-blue-100' : 'text-slate-400'}`}>
                        {formatTime(msg.timestamp)}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Streaming response */}
              {isTyping && (
                <div className="flex justify-start animate-fade-in">
                  <div className="max-w-[85%] bg-slate-100 dark:bg-slate-700 rounded-2xl p-3 md:p-4 text-slate-900 dark:text-slate-100">
                    {streamingContent ? (
                      <div className="text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {streamingContent}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                        <span className="text-sm text-slate-600 dark:text-slate-300">AI is thinking...</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Quick prompts - show when conversation is new */}
            {currentMessages.length <= 1 && !isTyping && (
              <div className="px-4 pb-2">
                <p className="text-xs text-slate-400 mb-2 flex items-center gap-1">
                  <Sparkles className="w-3 h-3" /> Suggested questions
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {QUICK_PROMPTS.map((qp, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setInput(qp.prompt);
                        textareaRef.current?.focus();
                      }}
                      className="flex items-center gap-2 p-2 text-left text-xs rounded-lg border border-slate-200 dark:border-slate-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:border-blue-300 transition"
                    >
                      <qp.icon className="w-4 h-4 text-blue-500 flex-shrink-0" />
                      <span className="text-slate-600 dark:text-slate-300">{qp.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="p-4 border-t bg-white dark:bg-slate-800">
              <form onSubmit={handleSend} className="relative">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  className="w-full pl-4 pr-12 py-3 rounded-xl border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none resize-none overflow-hidden"
                  placeholder="Ask about risk, inventory, suppliers, what-if scenarios..."
                  value={input}
                  onChange={handleTextareaChange}
                  onKeyDown={handleKeyDown}
                  disabled={isTyping}
                  style={{ minHeight: '48px', maxHeight: '150px' }}
                />
                <button
                  type="submit"
                  disabled={isTyping || !input.trim()}
                  className="absolute right-2 top-2 p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
              <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
                {excelData && (
                  <span className="flex items-center gap-1">
                    <Database className="w-3 h-3" />
                    {excelData.length} rows uploaded
                  </span>
                )}
                <span className="text-slate-300">|</span>
                <span>Shift+Enter for new line</span>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Bot className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                No Conversation Selected
              </h3>
              <p className="text-slate-500 mb-4">
                Start a new conversation to chat with the AI
              </p>
              <Button variant="primary" onClick={handleNewConversation}>
                Start New Conversation
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* New Chat Confirmation Modal */}
      {showNewChatConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                <FileText className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">Start New Conversation?</h3>
                <p className="text-sm text-slate-500">Current conversation will be saved</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setShowNewChatConfirm(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleNewConversation}>
                New Conversation
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
