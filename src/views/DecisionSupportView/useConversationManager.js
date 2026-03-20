// ============================================
// useConversationManager — conversation CRUD, search, selection
// Extracted from DecisionSupportView/index.jsx
// ============================================

import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../services/supabaseClient';
import { APP_NAME, ASSISTANT_NAME } from '../../config/branding';
import {
  STORAGE_KEY,
  createDefaultCanvasState,
  loadLocalConversations,
  saveLocalConversations,
  isTableUnavailable,
  markTableUnavailable,
} from './helpers.js';

function getConversationsDb() {
  return isTableUnavailable() ? null : supabase;
}

/**
 * Manages conversation list CRUD, selection, search, persistence and message
 * appending.  All conversation-related state lives here; the main component
 * consumes the returned object.
 *
 * @param {Object}   params
 * @param {Object}   params.user                - current authenticated user
 * @param {Function} params.addNotification     - notification helper
 * @param {Function} params.updateCanvasState   - canvas-state updater (from parent)
 * @param {string}   params.mode                - 'di' | 'ai_employee'
 */
export default function useConversationManager({
  user,
  addNotification,
  updateCanvasState,
  mode = 'di',
}) {
  const [conversations, setConversations] = useState([]);
  const [isConversationsLoading, setIsConversationsLoading] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);
  const [conversationDatasetContext, setConversationDatasetContext] = useState({});
  const [canvasStateByConversation, setCanvasStateByConversation] = useState({});

  // ── Load conversations on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    setIsConversationsLoading(true);

    // Filter conversations by workspace — untagged ones belong to 'di'
    const filterByWorkspace = (list) =>
      list.filter((c) => (c.workspace || 'di') === mode);

    const load = async () => {
      try {
        if (isTableUnavailable()) {
          const local = loadLocalConversations(user.id);
          if (active) {
            setConversations(filterByWorkspace(local));
            setIsConversationsLoading(false);
          }
          return;
        }

        const { data, error } = await getConversationsDb()
          .from('conversations')
          .select('*')
          .eq('user_id', user.id)
          .order('updated_at', { ascending: false });

        if (!active) return;
        if (!error && data) {
          // Merge Supabase data with localStorage — never blindly overwrite.
          // localStorage may contain conversations that failed to sync to Supabase
          // (e.g., insert failed due to schema/RLS). Supabase data takes priority
          // for conversations that exist in both.
          const local = loadLocalConversations(user.id);
          const localById = new Map(local.map((c) => [c.id, c]));
          const supabaseIds = new Set(data.map((c) => c.id));
          // Preserve workspace from localStorage when Supabase row lacks it
          // (workspace column may not exist in older schemas)
          const enrichedData = data.map((c) => {
            if (!c.workspace && localById.has(c.id)) {
              return { ...c, workspace: localById.get(c.id).workspace };
            }
            return c;
          });
          const localOnly = local.filter((c) => !supabaseIds.has(c.id));
          const merged = [...enrichedData, ...localOnly];
          saveLocalConversations(user.id, merged);
          setConversations(filterByWorkspace(merged));
          setIsConversationsLoading(false);
          return;
        }

        console.warn('[DSV] conversations table unavailable, falling back to localStorage:', error?.message);
        markTableUnavailable();
        const local = loadLocalConversations(user.id);
        setConversations(filterByWorkspace(local));
        setIsConversationsLoading(false);
      } catch (err) {
        console.warn('[DSV] failed to load conversations, falling back to localStorage:', err);
        if (!active) return;
        markTableUnavailable();
        const local = loadLocalConversations(user.id);
        setConversations(filterByWorkspace(local));
        setIsConversationsLoading(false);
      }
    };

    load();
    return () => {
      active = false;
    };
  }, [user?.id, mode]);

  // ── Auto-select first conversation when list changes ─────────────────────
  useEffect(() => {
    if (!Array.isArray(conversations)) return;

    if (conversations.length === 0) {
      if (currentConversationId !== null) {
        queueMicrotask(() => setCurrentConversationId(null));
      }
      return;
    }

    const hasCurrentConversation = conversations.some(
      (conversation) => conversation.id === currentConversationId
    );
    if (!hasCurrentConversation) {
      queueMicrotask(() => setCurrentConversationId(conversations[0].id));
    }
  }, [conversations, currentConversationId]);

  // ── Persist to localStorage whenever conversations change ────────────────
  // Merge with existing localStorage to avoid wiping conversations from other
  // workspaces (state only holds the current workspace's filtered subset).
  useEffect(() => {
    if (!user?.id || conversations.length === 0) return;
    const existing = loadLocalConversations(user.id);
    const currentIds = new Set(conversations.map((c) => c.id));
    // Keep conversations from OTHER workspaces, replace current workspace entries
    const otherWorkspace = existing.filter((c) => !currentIds.has(c.id) && (c.workspace || 'di') !== mode);
    saveLocalConversations(user.id, [...conversations, ...otherWorkspace]);
  }, [conversations, user?.id, mode]);

  // ── Derived state ────────────────────────────────────────────────────────
  const currentConversation = conversations.find(
    (conversation) => conversation.id === currentConversationId
  );

  const currentMessages = useMemo(
    () => currentConversation?.messages || [],
    [currentConversation?.messages]
  );

  const activeDatasetContext = conversationDatasetContext[currentConversationId] || null;
  const activeCanvasState = canvasStateByConversation[currentConversationId] || createDefaultCanvasState();

  // ── Persistence helper ───────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const persistConversation = useCallback((conversationId, payload) => {
    const db = getConversationsDb();
    if (!db || !user?.id || !conversationId || !payload) return;
    const updatePayload = {
      title: payload.title,
      messages: payload.messages,
      updated_at: payload.updated_at,
    };
    // Include workspace if present (column may not exist in older schemas)
    if (payload.workspace) updatePayload.workspace = payload.workspace;
    db
      .from('conversations')
      .update(updatePayload)
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .then(({ error }) => {
        if (error) {
          // If error is about unknown column 'workspace', retry without it
          if (error.message?.includes('workspace')) {
            const { workspace: _ws, ...withoutWorkspace } = updatePayload;
            db.from('conversations').update(withoutWorkspace)
              .eq('id', conversationId).eq('user_id', user.id)
              .then(({ error: retryErr }) => { if (retryErr) markTableUnavailable(); });
          } else {
            markTableUnavailable();
          }
        }
      });
  }, [user?.id]);

  // ── Append messages to the active conversation ───────────────────────────
  const appendMessagesToCurrentConversation = useCallback((messages) => {
    if (!currentConversationId || !Array.isArray(messages) || messages.length === 0) return;

    let updatedConversation = null;
    const updatedAt = new Date().toISOString();
    setConversations((prev) => prev.map((conversation) => {
      if (conversation.id !== currentConversationId) return conversation;
      updatedConversation = {
        ...conversation,
        messages: [...(conversation.messages || []), ...messages],
        updated_at: updatedAt,
      };
      return updatedConversation;
    }));

    if (updatedConversation) {
      persistConversation(currentConversationId, updatedConversation);
    }
  }, [currentConversationId, persistConversation]);

  // ── New conversation ─────────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleNewConversation = useCallback(async () => {
    if (!user?.id) {
      addNotification?.('Please sign in before starting a new conversation.', 'error');
      return;
    }

    setShowNewChatConfirm(false);

    const welcomeMessage = mode === 'ai_employee'
      ? 'Hi! I\'m your Digital Worker. Tell me what you need — upload data, generate reports, run forecasts, or just describe a task and I\'ll handle it.'
      : `Hello! I'm your **${ASSISTANT_NAME}**. Upload a CSV/XLSX (max 50MB) and ask for a plan or forecast.\n\nI will show deterministic execution artifacts in Canvas.`;

    const newConversation = {
      id: Date.now().toString(),
      user_id: user.id,
      workspace: mode,
      title: 'New Conversation',
      messages: [{
        role: 'ai',
        content: welcomeMessage,
      }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    setConversations((prev) => [newConversation, ...prev]);
    setCurrentConversationId(newConversation.id);
    updateCanvasState(newConversation.id, createDefaultCanvasState());

    const db = getConversationsDb();
    if (db) {
      db.from('conversations').insert([newConversation]).then(({ error }) => {
        if (error) {
          // workspace column may not exist yet — retry without it
          const { workspace: _ws, ...withoutWorkspace } = newConversation;
          db.from('conversations').insert([withoutWorkspace]).then(({ error: retryErr }) => {
            if (retryErr) markTableUnavailable();
          });
        }
      });
    }

    addNotification?.('New conversation ready.', 'success');
  }, [user?.id, addNotification, updateCanvasState, mode]);

  // ── Delete conversation ──────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleDeleteConversation = useCallback(async (conversationId) => {
    if (!user?.id) return;

    setConversationDatasetContext((prev) => {
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });
    setCanvasStateByConversation((prev) => {
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });

    setConversations((prev) => {
      const updated = prev.filter((conversation) => conversation.id !== conversationId);
      if (conversationId === currentConversationId) {
        setCurrentConversationId(updated.length > 0 ? updated[0].id : null);
      }
      return updated;
    });

    const db = getConversationsDb();
    if (db) {
      db.from('conversations').delete().eq('id', conversationId).eq('user_id', user.id).then(() => {});
    }
  }, [user?.id, currentConversationId]);

  return {
    // State
    conversations,
    setConversations,
    isConversationsLoading,
    conversationSearch,
    setConversationSearch,
    currentConversationId,
    setCurrentConversationId,
    showNewChatConfirm,
    setShowNewChatConfirm,
    conversationDatasetContext,
    setConversationDatasetContext,
    canvasStateByConversation,
    setCanvasStateByConversation,
    currentConversation,
    currentMessages,
    activeDatasetContext,
    activeCanvasState,

    // Handlers
    appendMessagesToCurrentConversation,
    persistConversation,
    handleNewConversation,
    handleDeleteConversation,
  };
}
