// ============================================
// useConversationManager — conversation CRUD, search, selection
// Extracted from DecisionSupportView/index.jsx
// ============================================

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../../services/infra/supabaseClient';
import { APP_NAME, ASSISTANT_NAME } from '../../config/branding';
import {
  STORAGE_KEY,
  TABLE_UNAVAILABLE_KEY,
  createDefaultCanvasState,
  loadLocalConversations,
  mergeConversationCollections,
  saveLocalConversations,
  isTableUnavailable,
  markTableUnavailable,
} from './helpers.js';

function getConversationsDb() {
  return isTableUnavailable() ? null : supabase;
}

const LAST_CONVERSATION_KEY_PREFIX = 'di_last_conversation_';

function saveLastConversationId(mode, id) {
  try { sessionStorage.setItem(`${LAST_CONVERSATION_KEY_PREFIX}${mode}`, id || ''); } catch { /* ignore */ }
}

function loadLastConversationId(mode) {
  try { return sessionStorage.getItem(`${LAST_CONVERSATION_KEY_PREFIX}${mode}`) || null; } catch { return null; }
}

/**
 * Synchronously merge the current workspace's conversations into localStorage.
 * Called immediately after every setConversations so data survives page
 * refresh / navigation even if the React effect hasn't run yet.
 */
function flushToLocalStorage(userId, workspaceConversations, currentMode) {
  if (!userId) return;
  const existing = loadLocalConversations(userId);
  const currentIds = new Set(workspaceConversations.map((c) => c.id));
  const otherWorkspace = existing.filter(
    (c) => !currentIds.has(c.id) && (c.workspace || 'di') !== currentMode,
  );
  const toSave = [...workspaceConversations, ...otherWorkspace];
  console.debug(`[DSV:flush] saving ${toSave.length} conversations (${workspaceConversations.length} current workspace=${currentMode}, ${otherWorkspace.length} other)`);
  saveLocalConversations(userId, toSave);
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
  const [conversations, setConversationsRaw] = useState([]);
  const [isConversationsLoading, setIsConversationsLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const [currentConversationId, setCurrentConversationIdRaw] = useState(() => loadLastConversationId(mode));
  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);
  const [conversationDatasetContext, setConversationDatasetContext] = useState({});
  const [canvasStateByConversation, setCanvasStateByConversation] = useState({});

  // Wrap setCurrentConversationId to also persist to sessionStorage.
  const setCurrentConversationId = useCallback((id) => {
    setCurrentConversationIdRaw(id);
    saveLastConversationId(mode, id);
  }, [mode]);

  // Keep a ref to the latest conversations for the beforeunload handler.
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  /**
   * Wrapper around setConversations that also synchronously writes to
   * localStorage so data is never lost between React renders.
   */
  const setConversations = useCallback((updater) => {
    setConversationsRaw((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      // Synchronous localStorage flush — runs INSIDE the updater so `next`
      // is the authoritative new value before React schedules the re-render.
      if (user?.id) {
        flushToLocalStorage(user.id, next, mode);
      }
      return next;
    });
  }, [user?.id, mode]);

  // ── Safety net: flush on page unload ────────────────────────────────────
  useEffect(() => {
    const onBeforeUnload = () => {
      if (user?.id) {
        flushToLocalStorage(user.id, conversationsRef.current, mode);
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [user?.id, mode]);

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
          console.info(`[DSV:convLoad] table unavailable, localStorage has ${local.length} conversations, ${filterByWorkspace(local).length} after workspace filter (mode=${mode})`);
          if (active) {
            setConversationsRaw(filterByWorkspace(local));
            setIsConversationsLoading(false);
            setHasLoadedOnce(true);
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
          const local = loadLocalConversations(user.id);
          const localById = new Map(local.map((c) => [c.id, c]));
          const supabaseIds = new Set(data.map((c) => c.id));
          const localOnly = local.filter((c) => !supabaseIds.has(c.id));
          const merged = mergeConversationCollections(data, local, mode);

          // ── Diagnostic logging ──
          const workspaceCounts = {};
          let localWins = 0;
          merged.forEach((c) => { const ws = c.workspace || 'di'; workspaceCounts[ws] = (workspaceCounts[ws] || 0) + 1; });
          data.forEach((c) => {
            const lv = localById.get(c.id);
            if (lv && (Array.isArray(lv.messages) ? lv.messages : []).length > (Array.isArray(c.messages) ? c.messages : []).length) localWins++;
          });
          const filtered = filterByWorkspace(merged);
          console.info(
            `[DSV:convLoad] Supabase: ${data.length} rows, localStorage: ${local.length} rows, localOnly: ${localOnly.length}, merged: ${merged.length}, localWins: ${localWins}, workspace counts:`, workspaceCounts,
            `→ after filter (mode=${mode}): ${filtered.length} conversations`
          );
          if (data.length > 0 && filtered.length === 0) {
            console.warn('[DSV:convLoad] ⚠️ All conversations filtered out! Sample workspace values:', data.slice(0, 3).map((c) => ({ id: c.id?.slice(-6), workspace: c.workspace, title: c.title?.slice(0, 20) })));
          }
          // Log message counts to diagnose "empty conversation" issues
          if (filtered.length > 0) {
            console.info('[DSV:convLoad] First 3 conversations message counts:', filtered.slice(0, 3).map((c) => ({
              id: String(c.id).slice(-6),
              title: String(c.title || '').slice(0, 25),
              msgs: Array.isArray(c.messages) ? c.messages.length : 0,
              supabaseMsgs: (Array.isArray((data.find((d) => d.id === c.id))?.messages) ? data.find((d) => d.id === c.id).messages.length : 0),
              localMsgs: (Array.isArray(localById.get(c.id)?.messages) ? localById.get(c.id).messages.length : 0),
            })));
          }

          saveLocalConversations(user.id, merged);
          setConversationsRaw(filtered);
          setIsConversationsLoading(false);
          setHasLoadedOnce(true);
          return;
        }

        console.warn('[DSV:convLoad] conversations query failed, falling back to localStorage:', error?.message);
        markTableUnavailable();
        const local = loadLocalConversations(user.id);
        console.info(`[DSV:convLoad] fallback localStorage: ${local.length} total, ${filterByWorkspace(local).length} after filter (mode=${mode})`);
        setConversationsRaw(filterByWorkspace(local));
        setIsConversationsLoading(false);
        setHasLoadedOnce(true);
      } catch (err) {
        console.warn('[DSV:convLoad] load failed, falling back to localStorage:', err);
        if (!active) return;
        markTableUnavailable();
        const local = loadLocalConversations(user.id);
        console.info(`[DSV:convLoad] error fallback localStorage: ${local.length} total, ${filterByWorkspace(local).length} after filter (mode=${mode})`);
        setConversationsRaw(filterByWorkspace(local));
        setIsConversationsLoading(false);
        setHasLoadedOnce(true);
      }
    };

    load();
    return () => {
      active = false;
    };
  }, [user?.id, mode]);

  // ── Auto-select conversation when list changes ──────────────────────────
  useEffect(() => {
    if (!Array.isArray(conversations)) return;

    if (conversations.length === 0) {
      if (currentConversationId !== null) {
        queueMicrotask(() => setCurrentConversationId(null));
      }
      return;
    }

    // If the current ID is already valid, keep it.
    const hasCurrentConversation = conversations.some(
      (conversation) => conversation.id === currentConversationId
    );
    if (hasCurrentConversation) return;

    // Pick the best conversation to auto-select:
    // prefer one with actual content (messages > 1) over empty ones.
    const withContent = conversations.find(
      (c) => Array.isArray(c.messages) && c.messages.length > 1
    );
    const best = withContent || conversations[0];
    queueMicrotask(() => setCurrentConversationId(best.id));
  }, [conversations, currentConversationId, setCurrentConversationId]);

  // ── Persist to localStorage whenever conversations change ────────────────
  // Merge with existing localStorage to avoid wiping conversations from other
  // workspaces (state only holds the current workspace's filtered subset).
  // NOTE: we must NOT skip when conversations.length === 0 — that would prevent
  // localStorage from reflecting deletions and could cause a destructive cycle
  // where filtered-out conversations are never saved back.
  // IMPORTANT: Skip until the initial load completes — otherwise the initial
  // empty state overwrites localStorage and wipes the current workspace's data.
  useEffect(() => {
    if (!user?.id || !hasLoadedOnce) return;
    const existing = loadLocalConversations(user.id);
    const currentIds = new Set(conversations.map((c) => c.id));
    // Keep conversations from OTHER workspaces, replace current workspace entries
    const otherWorkspace = existing.filter((c) => !currentIds.has(c.id) && (c.workspace || 'di') !== mode);
    saveLocalConversations(user.id, [...conversations, ...otherWorkspace]);
  }, [conversations, user?.id, mode, hasLoadedOnce]);

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
    if (!user?.id || !conversationId || !payload) return;
    const targetDb = db || supabase;
    if (!targetDb) return;

    const upsertPayload = {
      id: conversationId,
      user_id: user.id,
      title: payload.title,
      messages: payload.messages,
      updated_at: payload.updated_at,
    };
    if (payload.created_at) upsertPayload.created_at = payload.created_at;
    if (payload.workspace) upsertPayload.workspace = payload.workspace;

    targetDb
      .from('conversations')
      .upsert(upsertPayload, { onConflict: 'id' })
      .then(({ error }) => {
        if (!error) {
          sessionStorage.removeItem(TABLE_UNAVAILABLE_KEY);
          return;
        }

        console.warn('[DSV] Supabase persist failed:', error.message);
        // Older schemas may still lack workspace; retry once without it.
        if (error.message?.includes('workspace')) {
          const { workspace: _ws, ...withoutWorkspace } = upsertPayload;
          targetDb
            .from('conversations')
            .upsert(withoutWorkspace, { onConflict: 'id' })
            .then(({ error: retryErr }) => {
              if (retryErr) {
                markTableUnavailable();
              } else {
                sessionStorage.removeItem(TABLE_UNAVAILABLE_KEY);
              }
            });
          return;
        }

        if (db) {
          markTableUnavailable();
        } else {
          try {
            sessionStorage.setItem(TABLE_UNAVAILABLE_KEY, '1');
          } catch {
            // noop
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

    // Persist to Supabase — await to ensure the row exists before user navigates away
    const db = getConversationsDb();
    if (db) {
      const { error } = await db.from('conversations').insert([newConversation]);
      if (error) {
        console.warn(`[DSV:convNew] Supabase insert failed (with workspace): ${error.message}`);
        // workspace column may not exist yet — retry without it
        const { workspace: _ws, ...withoutWorkspace } = newConversation;
        const { error: retryErr } = await db.from('conversations').insert([withoutWorkspace]);
        if (retryErr) {
          console.warn(`[DSV:convNew] Supabase insert retry also failed: ${retryErr.message}`);
          markTableUnavailable();
        } else {
          console.info('[DSV:convNew] Supabase insert succeeded without workspace column');
        }
      } else {
        console.info(`[DSV:convNew] Supabase insert OK (id=${newConversation.id}, workspace=${newConversation.workspace})`);
      }
    } else {
      console.warn('[DSV:convNew] No DB available, conversation only in localStorage');
    }

    addNotification?.('New conversation ready.', 'success');
  }, [user?.id, addNotification, updateCanvasState, mode, setConversations]);

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
  }, [user?.id, currentConversationId, setConversations]);

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
