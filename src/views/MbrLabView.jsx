/**
 * MbrLabView — Upload any Excel → AI cleans the data → show results.
 *
 * Phase 1: Data Cleaning only.
 * Uses POST /execute-tool to send raw JSON + tool_hint to LLM,
 * which generates pandas cleaning code and executes it in sandbox.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';
import {
  Upload, FileSpreadsheet, Loader2, CheckCircle, AlertCircle,
  RotateCcw, Table2, Sparkles, Download, Play,
} from 'lucide-react';
import { callLLM } from '../services/ai-infra/aiEmployeeLLMService';

const ML_API = import.meta.env.VITE_ML_API_URL || 'http://localhost:8000';
const MAX_FILE_SIZE_MB = 50;

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadExcel(tables, filename) {
  const wb = XLSX.utils.book_new();
  const usedNames = new Set();
  for (const t of tables) {
    let name = (t.label || 'Sheet').replace(/^cleaned_/, '').slice(0, 31);
    // Deduplicate sheet names
    let base = name;
    let i = 2;
    while (usedNames.has(name)) {
      name = `${base.slice(0, 28)}_${i}`;
      i++;
    }
    usedNames.add(name);
    const ws = XLSX.utils.json_to_sheet(t.data);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, filename);
}

// ── Main View ───────────────────────────────────────────────────────────────

export default function MbrLabView() {
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);

  // Raw data
  const [sheets, setSheets] = useState(null);
  const [sheetNames, setSheetNames] = useState([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);

  // Cleaning result
  const [cleanResult, setCleanResult] = useState(null);
  const [cleanDuration, setCleanDuration] = useState(0);
  const [cleanCode, setCleanCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [cleaningStage, setCleaningStage] = useState(''); // profiling → llm → engine → done

  // View: 'raw' | 'cleaned', active cleaned sheet
  const [viewMode, setViewMode] = useState('raw');
  const [activeCleanedSheet, setActiveCleanedSheet] = useState('');

  // User rules
  const [userRules, setUserRules] = useState('');
  const [showRules, setShowRules] = useState(false);

  // Rule store (localStorage) — full structure from gpt_bootstrap
  const RULE_STORE_KEY = 'mbr_lab_rule_store';
  const [ruleStore, setRuleStore] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RULE_STORE_KEY) || 'null'); } catch { return null; }
  });
  const hasRuleStore = ruleStore && (
    Object.keys(ruleStore.entity_mappings || {}).length > 0 ||
    Object.keys(ruleStore.categorical_rules || {}).length > 0
  );
  const [showMappingEditor, setShowMappingEditor] = useState(false);
  const [editingMappings, setEditingMappings] = useState('');
  const [modeUsed, setModeUsed] = useState('');

  // ── MBR Agent State ──────────────────────────────────────────────────────
  const [agentState, setAgentState] = useState({
    phase: 'idle', // idle | planning | executing | synthesizing | done | error
    plan: [],
    reasoning: '',
    steps: [],
    currentToolIndex: -1,
    summaryChunks: [],
    totalDuration: null,
    tablesGenerated: null,
    totalArtifacts: null,
    downloadId: null,
    keyTables: [],
    error: null,
  });
  const agentScrollRef = useRef(null);
  const summaryScrollRef = useRef(null);

  // Auto-scroll agent steps and summary
  useEffect(() => {
    if (agentScrollRef.current) agentScrollRef.current.scrollTop = agentScrollRef.current.scrollHeight;
  }, [agentState.steps, agentState.currentToolIndex]);
  useEffect(() => {
    if (summaryScrollRef.current) summaryScrollRef.current.scrollTop = summaryScrollRef.current.scrollHeight;
  }, [agentState.summaryChunks]);

  const fileInputRef = useRef(null);

  // ── Parse Excel ──────────────────────────────────────────────────────────

  const parseWorkbook = useCallback((arrayBuffer, name, size) => {
    try {
      setPhase('uploading');
      setError(null);
      const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
      const parsed = {};
      for (const sn of wb.SheetNames) {
        parsed[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn]);
      }
      setSheets(parsed);
      setSheetNames(wb.SheetNames);
      setActiveSheet(wb.SheetNames[0] || '');
      setFileName(name);
      setFileSize(size);
      setPhase('previewing');
      setCleanResult(null);
      setCleanDuration(0);
      setCleanCode('');
      setViewMode('raw');
      setActiveCleanedSheet('');
    } catch (err) {
      setError(`Failed to parse file: ${err.message}`);
      setPhase('error');
    }
  }, []);

  const handleFileDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      setError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max ${MAX_FILE_SIZE_MB} MB.`);
      setPhase('error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => parseWorkbook(ev.target.result, file.name, file.size);
    reader.readAsArrayBuffer(file);
  }, [parseWorkbook]);

  const handleLoadSample = useCallback(async () => {
    try {
      setPhase('uploading');
      setError(null);
      const resp = await fetch('/sample_data/mbr_sample.xlsx');
      if (!resp.ok) throw new Error(`Failed to load sample (${resp.status})`);
      const buf = await resp.arrayBuffer();
      parseWorkbook(buf, 'mbr_sample.xlsx (sample)', buf.byteLength);
    } catch (err) {
      setError(`Failed to load sample: ${err.message}`);
      setPhase('error');
    }
  }, [parseWorkbook]);

  // ── Run Data Cleaning (3-step pipeline, results shown live) ─────────────

  // Live log entries shown during cleaning
  const [liveLog, setLiveLog] = useState([]);

  const addLog = useCallback((msg) => {
    setLiveLog(prev => [...prev, { time: Date.now(), msg }]);
  }, []);

  const runCleaning = useCallback(async () => {
    if (!sheets) return;
    setPhase('cleaning');
    setError(null);
    setCleanResult(null);
    setCleaningStage('profiling');
    setLiveLog([]);
    const start = Date.now();

    const post = async (url, body) => {
      const res = await fetch(`${ML_API}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${url} failed (${res.status}): ${await res.text()}`);
      const data = await res.json();
      if (data.ok === false) throw new Error(data.error || `${url} returned ok=false`);
      return data;
    };

    try {
      // ── Step 1: Profile (backend, no LLM) ─────────────────────────
      addLog('Profiling data structure...');
      const step1 = await post('/cleaning/profile', {
        tool_hint: 'profile',
        input_data: { sheets, rule_store: ruleStore, user_rules: userRules },
      });
      const { profile, mode, prompts } = step1;
      addLog(`Profile done (${step1.execution_ms}ms). Mode: ${mode}`);

      const totalIssues = Object.values(profile?.sheet_profiles || {})
        .reduce((sum, sp) => sum + (sp.issues_detected?.length || 0), 0);
      if (totalIssues > 0) addLog(`Found ${totalIssues} data quality issues`);

      // ── Step 2: LLM Mapping (frontend calls Supabase ai-proxy) ────
      setCleaningStage('llm');
      let llm_mappings = {};
      let updatedRules = ruleStore || {};
      let llm_provider = '';
      let llm_model = '';

      const callAI = async (systemPrompt, userPrompt, sheetLabel = '', model = 'deepseek-chat') => {
        const result = await callLLM({
          taskType: 'task_decomposition',
          systemPrompt,
          prompt: userPrompt,
          temperature: model === 'deepseek-reasoner' ? undefined : 0.1,
          maxTokens: 8000,
          jsonMode: false,
          modelOverride: { provider: 'deepseek', model_name: model },
        });
        llm_provider = result.provider || 'deepseek';
        llm_model = result.model || 'deepseek-chat';

        const text = (result.text || '').trim();
        // Log raw response (truncated)
        if (sheetLabel) {
          const preview = text.length > 120 ? text.slice(0, 120) + '...' : text;
          addLog(`    AI raw (${sheetLabel}): ${preview}`);
        }

        try {
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start !== -1 && end !== -1) {
            return JSON.parse(text.slice(start, end + 1));
          }
          return JSON.parse(text);
        } catch {
          addLog(`    WARN: Failed to parse JSON from AI response`);
          console.warn('[MbrLab] Failed to parse LLM JSON:', text.slice(0, 500));
          return {};
        }
      };

      if (mode === 'bootstrap' && prompts?.per_sheet) {
        // Per-sheet parallel bootstrap
        const sheetKeys = Object.keys(prompts.per_sheet);
        addLog(`Bootstrap: ${sheetKeys.length} sheets via deepseek-chat (parallel, max 3)`);
        setCleaningStage('llm_bootstrap');

        const MAX_CONCURRENT = 3;
        let completed = 0;

        const processSheet = async (sheetName) => {
          const t = Date.now();
          const idx = completed + 1;
          addLog(`  [${idx}/${sheetKeys.length}] ${sheetName} — calling AI...`);
          try {
            const { system, user } = prompts.per_sheet[sheetName];
            const rules = await callAI(system, user, sheetName, 'deepseek-chat');
            completed++;
            const ruleCount = ['entity_mappings', 'categorical_rules']
              .reduce((s, sec) => s + Object.values(rules?.[sec] || {}).reduce((s2, m) => s2 + Object.keys(m).length, 0), 0);
            addLog(`  [${completed}/${sheetKeys.length}] ${sheetName} — done (${((Date.now() - t) / 1000).toFixed(0)}s, ${ruleCount} rules)`);

            for (const sec of ['entity_mappings', 'categorical_rules']) {
              for (const [colKey, mapping] of Object.entries(rules?.[sec] || {})) {
                const fullKey = colKey.includes('.') ? colKey : `${sheetName}.${colKey}`;
                const entries = Object.entries(mapping).slice(0, 2);
                if (entries.length > 0) {
                  addLog(`    ${fullKey}: ${entries.map(([f, t]) => `${f} → ${t}`).join(', ')}${Object.keys(mapping).length > 2 ? ' ...' : ''}`);
                }
              }
            }
            return { sheetName, rules: rules || {} };
          } catch (err) {
            completed++;
            addLog(`  [${completed}/${sheetKeys.length}] ${sheetName} — FAILED: ${err.message}`);
            return { sheetName, rules: {} };
          }
        };

        // Concurrency-limited parallel execution
        const results = [];
        const executing = new Set();
        for (const sn of sheetKeys) {
          const p = processSheet(sn).then(r => { executing.delete(p); return r; });
          executing.add(p);
          results.push(p);
          if (executing.size >= MAX_CONCURRENT) await Promise.race(executing);
        }
        const sheetResults = await Promise.all(results);

        // Merge per-sheet rules
        const combined = {
          entity_mappings: {}, categorical_rules: {},
          format_rules: { date_formats_by_source: {}, sku_case: 'preserve', currency_code_overrides: {} },
          flag_rules: { ignore_flags: [], notes: '' },
          junk_patterns: { test_data_values: [], placeholder_dates: ['9999-12-31', '1900-01-01'], system_accounts: ['SYSTEM', 'MIGRATION', 'AUTO', 'BATCH'] },
          _metadata: { created_by: llm_model || 'deepseek-chat' },
        };
        for (const { sheetName, rules } of sheetResults) {
          if (!rules || typeof rules !== 'object') continue;
          for (const sec of ['entity_mappings', 'categorical_rules']) {
            for (const [colKey, mapping] of Object.entries(rules[sec] || {})) {
              const fullKey = colKey.includes('.') ? colKey : `${sheetName}.${colKey}`;
              combined[sec][fullKey] = { ...(combined[sec][fullKey] || {}), ...mapping };
            }
          }
        }
        updatedRules = combined;
        llm_mappings = {};
        for (const sec of ['entity_mappings', 'categorical_rules']) {
          for (const [k, m] of Object.entries(combined[sec])) {
            llm_mappings[k] = { ...(llm_mappings[k] || {}), ...m };
          }
        }
        const totalRules = Object.values(llm_mappings).reduce((s, m) => s + Object.keys(m).length, 0);
        addLog(`Bootstrap complete: ${totalRules} total rules from ${sheetKeys.length} sheets`);

      } else if (mode === 'incremental' && prompts?.system) {
        addLog('Incremental: calling AI for new values...');
        const rules = await callAI(prompts.system, prompts.user, 'incremental');
        if (rules && typeof rules === 'object') {
          llm_mappings = rules;
          // Merge into rule store
          for (const [k, m] of Object.entries(rules)) {
            const sec = k.includes('customer') || k.includes('supplier') || k.includes('location')
              ? 'entity_mappings' : 'categorical_rules';
            updatedRules = { ...updatedRules, [sec]: { ...(updatedRules[sec] || {}), [k]: { ...((updatedRules[sec] || {})[k] || {}), ...m } } };
          }
        }
        const mc = Object.values(llm_mappings).reduce((s, m) => s + Object.keys(m).length, 0);
        addLog(`Incremental done. ${mc} rules. Model: ${llm_provider}/${llm_model}`);

      } else if (mode === 'engine_only') {
        addLog('Rule store fully covers — no AI needed');
        // Flatten existing rule store to engine format
        for (const sec of ['entity_mappings', 'categorical_rules']) {
          for (const [k, m] of Object.entries(ruleStore?.[sec] || {})) {
            llm_mappings[k] = { ...(llm_mappings[k] || {}), ...m };
          }
        }
      }

      // ── Step 3: Apply (backend, no LLM) ───────────────────────────
      setCleaningStage('engine');
      addLog('Applying rules and cleaning data...');

      const step3 = await post('/cleaning/apply', {
        tool_hint: 'apply',
        input_data: { sheets, llm_mappings },
      });

      addLog(`Engine done (${step3.execution_ms}ms). ${step3.total_original_rows} → ${step3.total_cleaned_rows} rows.`);
      for (const entry of (step3.log || []).slice(0, 10)) {
        if (entry.action === 'sheet_summary') {
          addLog(`  ${entry.sheet}: ${entry.original_rows} → ${entry.cleaned_rows} rows (removed ${entry.removed})`);
        } else if (entry.action === 'apply_mapping') {
          addLog(`  ${entry.sheet}.${entry.column}: ${entry.cells_changed} cells standardized`);
        } else if (entry.action === 'add_quality_flags') {
          addLog(`  ${entry.sheet}: ${entry.rows_flagged} rows flagged`);
        }
      }

      // Alert on unmapped values
      const unmapped = step3.unmapped_values || [];
      if (unmapped.length > 0) {
        addLog(`  ⚠ ${unmapped.length} new values not in rule store:`);
        for (const u of unmapped.slice(0, 5)) {
          addLog(`    ${u.sheet}.${u.column}: "${u.value}"`);
        }
        if (unmapped.length > 5) addLog(`    ... and ${unmapped.length - 5} more`);
      }

      // ── Step 4: Deep Clean (LLM #2 writes Python code) ───────────
      let finalArtifacts = step3.artifacts;

      const deepPrompt = step3.deep_clean_prompt;
      if (deepPrompt?.system && deepPrompt?.user) {
        setCleaningStage('deep_clean');
        addLog('LLM #2: Generating Python code for remaining issues...');

        try {
          const codeResult = await callLLM({
            taskType: 'dynamic_tool_generation',
            systemPrompt: deepPrompt.system,
            prompt: deepPrompt.user,
            temperature: 0.1,
            maxTokens: 8000,
            jsonMode: false,
            modelOverride: { provider: 'deepseek', model_name: 'deepseek-chat' },
          });

          const rawCode = (codeResult.text || '').trim();
          addLog(`  AI generated ${rawCode.length} chars of Python code`);

          // Extract code block
          let code = rawCode;
          const codeMatch = rawCode.match(/```(?:python)?\s*([\s\S]*?)```/);
          if (codeMatch) code = codeMatch[1].trim();
          // Or extract from JSON wrapper
          if (code.includes('"code"')) {
            try {
              const parsed = JSON.parse(code.slice(code.indexOf('{'), code.lastIndexOf('}') + 1));
              if (parsed.code) code = parsed.code;
            } catch { /* use raw */ }
          }

          if (code && code.includes('def run(')) {
            // Build cleaned_sheets from step3 artifacts for sandbox input
            const cleanedSheets = {};
            for (const a of step3.artifacts) {
              if (a.type === 'table' && a.label?.startsWith('cleaned_')) {
                const sn = a.label.replace('cleaned_', '');
                cleanedSheets[sn] = a.data;
              }
            }

            addLog('  Executing deep-clean code in sandbox...');
            const step4 = await post('/cleaning/deep-clean', {
              tool_hint: 'deep-clean',
              input_data: { code, cleaned_sheets: cleanedSheets },
            });

            if (step4.ok && step4.artifacts?.length > 0) {
              // Replace engine artifacts with deep-cleaned versions
              const deepTables = step4.artifacts.filter(a => a.type === 'table');
              if (deepTables.length > 0) {
                // Merge: replace matching sheets, keep others
                const deepMap = new Map(deepTables.map(a => [a.label.replace('deep_cleaned_', 'cleaned_'), a]));
                finalArtifacts = step3.artifacts.map(a => {
                  if (a.type === 'table') {
                    const deepVersion = deepMap.get(a.label);
                    if (deepVersion) return { ...deepVersion, label: a.label };
                  }
                  return a;
                });
                addLog(`  Deep clean done (${step4.execution_ms}ms). ${deepTables.length} sheets updated.`);
              } else {
                addLog('  Deep clean: no changes needed.');
              }
            } else if (step4.error) {
              addLog(`  Deep clean code failed: ${step4.error}`);
              // Keep engine results
            } else {
              addLog('  Deep clean: no changes needed.');
            }
          } else {
            addLog('  LLM #2 did not return valid Python code, skipping deep clean.');
          }
        } catch (err) {
          addLog(`  Deep clean failed: ${err.message} (using engine results)`);
          // Keep engine results on failure
        }
      }

      setCleaningStage('done');
      const duration = Date.now() - start;
      setCleanResult({
        ok: true,
        artifacts: finalArtifacts,
        llm_provider,
        llm_model,
        code: JSON.stringify(updatedRules || {}, null, 2),
      });
      setCleanDuration(duration);
      setCleanCode(JSON.stringify(updatedRules || {}, null, 2));
      setViewMode('cleaned');

      if (updatedRules && typeof updatedRules === 'object' && Object.keys(updatedRules).length > 0) {
        localStorage.setItem(RULE_STORE_KEY, JSON.stringify(updatedRules));
        setRuleStore(updatedRules);
      }
      setModeUsed(mode);

      const firstTable = (finalArtifacts || []).find(a => a.type === 'table' && Array.isArray(a.data));
      setActiveCleanedSheet(firstTable?.label || '');
      setPhase('complete');

    } catch (err) {
      console.error('[MbrLab] Cleaning error:', err);
      addLog(`ERROR: ${err.message}`);
      setError(err.message);
      setPhase('error');
    }
  }, [sheets, userRules, ruleStore, addLog]);

  const handleReset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setSheets(null);
    setSheetNames([]);
    setActiveSheet('');
    setFileName('');
    setFileSize(0);
    setCleanResult(null);
    setCleanDuration(0);
    setCleanCode('');
    setViewMode('raw');
    setShowCode(false);
    setActiveCleanedSheet('');
    setUserRules('');
    setShowRules(false);
    setModeUsed('');
    setCleaningStage('');
    setAgentState({
      phase: 'idle', plan: [], reasoning: '', steps: [], currentToolIndex: -1,
      summaryChunks: [], totalDuration: null, tablesGenerated: null, totalArtifacts: null,
      downloadId: null, keyTables: [], error: null,
    });
  }, []);

  // ── MBR Agent: SSE stream consumer ────────────────────────────────────────

  const runMbrAgent = useCallback(async () => {
    // Build sheets from cleaned data if available, otherwise raw
    let sheetsPayload = {};
    if (cleanResult?.artifacts) {
      for (const a of cleanResult.artifacts) {
        if (a.type === 'table' && Array.isArray(a.data) && a.data.length > 0) {
          const name = (a.label || '').replace(/^cleaned_/, '');
          sheetsPayload[name] = a.data;
        }
      }
    }
    if (Object.keys(sheetsPayload).length === 0 && sheets) {
      sheetsPayload = sheets;
    }
    if (Object.keys(sheetsPayload).length === 0) return;

    setPhase('agent');
    setAgentState(prev => ({ ...prev, phase: 'planning', error: null }));

    try {
      const resp = await fetch(`${ML_API}/agent/mbr/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheets: sheetsPayload }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Stream failed (${resp.status}): ${errText}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const raw = JSON.parse(line.slice(6));
              const event = { type: raw.type, ...(raw.payload || {}), timestamp: raw.timestamp };
              setAgentState(prev => reduceAgentEvent(prev, event));
            } catch { /* ignore parse errors */ }
          }
        }
      }
    } catch (err) {
      setAgentState(prev => ({ ...prev, phase: 'error', error: err.message }));
      setError(err.message);
    }
  }, [cleanResult, sheets]);

  // ── Agent event reducer ───────────────────────────────────────────────────

  // ── Derived data ─────────────────────────────────────────────────────────

  const currentSheetData = sheets?.[activeSheet] || [];
  const columns = currentSheetData.length > 0 ? Object.keys(currentSheetData[0]) : [];
  const previewRows = currentSheetData.slice(0, 20);
  const totalRows = sheetNames.reduce((sum, name) => sum + (sheets?.[name]?.length || 0), 0);

  // Extract ALL cleaned table artifacts
  const cleanedTables = (cleanResult?.artifacts || []).filter(a => a.type === 'table' && Array.isArray(a.data) && a.data.length > 0);
  const activeCleanedData = cleanedTables.find(t => t.label === activeCleanedSheet)?.data || [];
  const activeCleanedCols = activeCleanedData.length > 0 && typeof activeCleanedData[0] === 'object' ? Object.keys(activeCleanedData[0]) : [];

  // Extract summary
  const summaryArtifact = (cleanResult?.artifacts || []).find(a =>
    a.type === 'summary' || a.label?.toLowerCase().includes('summary')
  );
  const summary = summaryArtifact?.data || cleanResult?.result;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-primary)]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--border-primary)] flex-shrink-0">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">MBR Lab</h1>
          <p className="text-xs text-[var(--text-secondary)]">Upload Excel &rarr; AI Clean &rarr; MBR Analysis</p>
        </div>
        {phase !== 'idle' && (
          <button onClick={handleReset}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs
              text-[var(--text-secondary)] hover:text-[var(--text-primary)]
              hover:bg-[var(--bg-secondary)] transition-colors">
            <RotateCcw size={14} /> Start Over
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Panel */}
        <div className="w-80 flex-shrink-0 border-r border-[var(--border-primary)] p-4 flex flex-col gap-4 overflow-y-auto">

          {/* Drop Zone */}
          {(phase === 'idle' || (phase === 'error' && !sheets)) && (
            <div onDragOver={(e) => e.preventDefault()} onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-[var(--border-primary)] rounded-xl p-8
                text-center cursor-pointer transition-colors
                hover:border-[var(--brand-500)] hover:bg-[var(--brand-500)]/5">
              <Upload size={28} className="mx-auto mb-2 text-[var(--text-tertiary)]" />
              <p className="text-sm font-medium text-[var(--text-primary)]">Drop Excel or CSV</p>
              <p className="text-xs text-[var(--text-tertiary)] mt-1">max {MAX_FILE_SIZE_MB} MB</p>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileDrop} />
            </div>
          )}

          {phase === 'idle' && (
            <button onClick={handleLoadSample}
              className="w-full flex items-center justify-center gap-2 px-3 py-2
                rounded-lg border border-[var(--border-primary)] text-xs
                text-[var(--text-secondary)] hover:text-[var(--text-primary)]
                hover:bg-[var(--bg-secondary)] transition-colors">
              <FileSpreadsheet size={14} /> Load Sample Data
            </button>
          )}

          {phase === 'uploading' && (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={20} className="animate-spin text-[var(--brand-500)]" />
              <span className="ml-2 text-sm text-[var(--text-secondary)]">Parsing...</span>
            </div>
          )}

          {/* File info */}
          {sheets && phase !== 'idle' && phase !== 'uploading' && (
            <>
              <div className="rounded-lg border border-[var(--border-primary)] p-3 bg-[var(--bg-secondary)]">
                <div className="flex items-center gap-2 min-w-0">
                  <FileSpreadsheet size={14} className="text-emerald-500 flex-shrink-0" />
                  <span className="text-xs font-medium text-[var(--text-primary)] truncate">{fileName}</span>
                </div>
                <p className="text-xs text-[var(--text-tertiary)] mt-1">
                  {sheetNames.length} sheet{sheetNames.length > 1 ? 's' : ''} &middot; {totalRows.toLocaleString()} rows &middot; {formatBytes(fileSize)}
                </p>
              </div>

              {/* Rule store */}
              {hasRuleStore && (
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-blue-600">
                      Rule Store
                      {ruleStore?._metadata?.created_by && (
                        <span className="font-normal text-[var(--text-tertiary)]"> (built by {ruleStore._metadata.created_by})</span>
                      )}
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setShowMappingEditor(!showMappingEditor);
                          if (!showMappingEditor) {
                            setEditingMappings(JSON.stringify(ruleStore, null, 2));
                          }
                        }}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        {showMappingEditor ? 'Close' : 'View / Edit'}
                      </button>
                      <button
                        onClick={() => {
                          const blob = new Blob([JSON.stringify(ruleStore, null, 2)], { type: 'application/json' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'cleaning_rules.json';
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                        className="text-xs text-emerald-600 hover:underline"
                      >
                        Export
                      </button>
                      <label className="text-xs text-blue-600 hover:underline cursor-pointer">
                        Import
                        <input type="file" accept=".json" className="hidden" onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = (ev) => {
                            try {
                              const imported = JSON.parse(ev.target.result);
                              localStorage.setItem(RULE_STORE_KEY, JSON.stringify(imported));
                              setRuleStore(imported);
                            } catch { alert('Invalid JSON file'); }
                          };
                          reader.readAsText(file);
                          e.target.value = '';
                        }} />
                      </label>
                      <button
                        onClick={() => {
                          localStorage.removeItem(RULE_STORE_KEY);
                          setRuleStore(null);
                          setShowMappingEditor(false);
                        }}
                        className="text-xs text-[var(--text-tertiary)] hover:text-red-500 transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  {/* Compact view */}
                  {!showMappingEditor && (
                    <div className="space-y-0.5 text-xs">
                      {Object.entries(ruleStore?.entity_mappings || {}).map(([colKey, mapping]) => (
                        <div key={colKey} className="flex items-center justify-between">
                          <span className="text-[var(--text-secondary)] truncate">{colKey}</span>
                          <span className="text-[var(--text-tertiary)] flex-shrink-0 ml-2">{Object.keys(mapping).length} entity</span>
                        </div>
                      ))}
                      {Object.entries(ruleStore?.categorical_rules || {}).map(([colKey, mapping]) => (
                        <div key={colKey} className="flex items-center justify-between">
                          <span className="text-[var(--text-secondary)] truncate">{colKey}</span>
                          <span className="text-[var(--text-tertiary)] flex-shrink-0 ml-2">{Object.keys(mapping).length} category</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Full editor */}
                  {showMappingEditor && (
                    <div className="space-y-2">
                      <textarea
                        value={editingMappings}
                        onChange={(e) => setEditingMappings(e.target.value)}
                        rows={12}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--border-primary)]
                          bg-[var(--bg-primary)] text-xs font-mono text-[var(--text-primary)]
                          resize-y min-h-[120px]
                          focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            try {
                              const parsed = JSON.parse(editingMappings);
                              localStorage.setItem(RULE_STORE_KEY, JSON.stringify(parsed));
                              setRuleStore(parsed);
                              setShowMappingEditor(false);
                            } catch (e) {
                              alert('Invalid JSON: ' + e.message);
                            }
                          }}
                          className="flex-1 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium
                            hover:bg-blue-700 transition-colors"
                        >
                          Save Changes
                        </button>
                        <button
                          onClick={() => setShowMappingEditor(false)}
                          className="px-3 py-1.5 rounded-lg border border-[var(--border-primary)] text-xs
                            text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Custom rules (collapsible) */}
              {(phase === 'previewing' || (phase === 'error' && sheets)) && (
                <div>
                  <button onClick={() => setShowRules(!showRules)}
                    className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                    {showRules ? '\u25BE' : '\u25B8'} Custom cleaning rules (optional)
                  </button>
                  {showRules && (
                    <div className="relative mt-2">
                      <textarea
                        value={userRules}
                        onChange={(e) => setUserRules(e.target.value.slice(0, 2000))}
                        placeholder={'Optional: add rules for better results.\n\u2022 Date format: APAC uses DD/MM/YYYY, Americas uses MM/DD/YYYY\n\u2022 "SteelCo Industries Ltd" was acquired by "SteelCo Ltd"\n\u2022 Negative inventory is normal - do not flag\n\u2022 Keep FY2024 data, do not remove'}
                        rows={4}
                        maxLength={2000}
                        className="w-full px-3 py-2 rounded-lg border border-[var(--border-primary)]
                          bg-[var(--bg-primary)] text-xs text-[var(--text-primary)]
                          placeholder:text-[var(--text-tertiary)] resize-y min-h-[60px]
                          focus:outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30
                          focus:border-[var(--brand-500)]"
                      />
                      <span className="absolute bottom-2 right-3 text-[10px] text-[var(--text-tertiary)]">
                        {userRules.length}/2000
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Clean button */}
              {(phase === 'previewing' || (phase === 'error' && sheets)) && (
                <button onClick={runCleaning}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                    rounded-lg bg-[var(--brand-600)] text-white text-sm font-medium
                    hover:bg-[var(--brand-700)] transition-colors">
                  <Sparkles size={16} /> Run Data Cleaning
                </button>
              )}

              {phase === 'cleaning' && (
                <CleaningProgress stage={cleaningStage} liveLog={liveLog} />
              )}

              {/* Cleaning complete */}
              {phase === 'complete' && cleanResult && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle size={14} className="text-emerald-500 flex-shrink-0" />
                      <span className="text-xs font-medium text-emerald-600">Cleaning Complete</span>
                      <span className="text-xs text-[var(--text-tertiary)] ml-auto">{(cleanDuration / 1000).toFixed(1)}s</span>
                    </div>
                    {/* Mode indicator */}
                    {modeUsed && (
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          modeUsed === 'bootstrap' ? 'bg-amber-500' :
                          modeUsed === 'incremental' ? 'bg-blue-500' :
                          'bg-emerald-500'
                        }`} />
                        <span className="text-xs text-[var(--text-tertiary)]">
                          {modeUsed === 'bootstrap' ? 'Initial setup (strong model)' :
                           modeUsed === 'incremental' ? 'Learning (updating rules)' :
                           'Optimized (rules only, no AI)'}
                        </span>
                      </div>
                    )}
                    {cleanResult.llm_provider && (
                      <p className="text-xs text-[var(--text-tertiary)] mt-1">
                        {cleanResult.llm_provider}/{cleanResult.llm_model}
                      </p>
                    )}
                  </div>

                  {/* Per-sheet summary cards */}
                  {summary && typeof summary === 'object' && !Array.isArray(summary) && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide">Summary</p>
                      {Object.entries(summary).map(([sheetKey, stats]) => (
                        <div key={sheetKey} className="rounded-lg border border-[var(--border-primary)] p-2.5 space-y-1">
                          <p className="text-xs font-medium text-[var(--text-primary)]">{sheetKey}</p>
                          {typeof stats === 'object' && !Array.isArray(stats) ? (
                            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs">
                              {stats.original_rows !== undefined && (
                                <span className="text-[var(--text-tertiary)]">Rows: {stats.original_rows} &rarr; {stats.cleaned_rows ?? stats.original_rows}</span>
                              )}
                              {stats.nulls_found > 0 && (
                                <span className="text-amber-600">Nulls: {stats.nulls_found}</span>
                              )}
                              {(stats.duplicates_removed > 0 || stats.duplicates_found > 0) && (
                                <span className="text-amber-600">Dupes: {stats.duplicates_removed ?? stats.duplicates_found}</span>
                              )}
                              {stats.outliers_found > 0 && (
                                <span className="text-orange-600">Outliers: {stats.outliers_found}</span>
                              )}
                              {stats.changes_made && Array.isArray(stats.changes_made) && stats.changes_made.length > 0 && (
                                <span className="col-span-2 text-[var(--text-secondary)]">
                                  {stats.changes_made.join('; ')}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-[var(--text-tertiary)]">{JSON.stringify(stats)}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Download all cleaned sheets as one Excel file */}
                  {cleanedTables.length > 0 && (
                    <button
                      onClick={() => downloadExcel(cleanedTables, fileName.replace(/\.\w+$/, '') + '_cleaned.xlsx')}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                        rounded-lg bg-emerald-600 text-white text-sm font-medium
                        hover:bg-emerald-700 transition-colors">
                      <Download size={16} /> Download Cleaned Excel
                    </button>
                  )}

                  {/* Run MBR Agent */}
                  {agentState.phase === 'idle' && (
                    <button onClick={runMbrAgent}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                        rounded-lg bg-indigo-600 text-white text-sm font-medium
                        hover:bg-indigo-700 transition-colors">
                      <Play size={16} /> Run MBR Analysis
                    </button>
                  )}
                  {agentState.phase !== 'idle' && agentState.phase !== 'done' && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                      <Loader2 size={14} className="text-indigo-400 animate-spin" />
                      <span className="text-xs font-medium text-indigo-300">
                        {agentState.phase === 'planning' ? 'Planning analysis...' :
                         agentState.phase === 'executing' ? 'Running tools...' :
                         agentState.phase === 'synthesizing' ? 'Writing summary...' :
                         'Working...'}
                      </span>
                    </div>
                  )}
                  {agentState.phase === 'done' && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                      <CheckCircle size={14} className="text-emerald-500" />
                      <span className="text-xs font-medium text-emerald-400">MBR Analysis Complete</span>
                    </div>
                  )}

                  {/* AI Response Log */}
                  <button onClick={() => setShowCode(!showCode)}
                    className="text-xs text-[var(--brand-600)] hover:underline">
                    {showCode ? 'Hide' : 'Show'} AI Response Details
                  </button>
                  {showCode && (
                    <div className="space-y-3">
                      {/* Model info */}
                      <div className="rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-primary)] p-2.5 space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-[var(--text-secondary)]">Provider</span>
                          <span className="font-mono text-[var(--text-primary)]">{cleanResult?.llm_provider || 'N/A'}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-[var(--text-secondary)]">Model</span>
                          <span className="font-mono text-[var(--text-primary)]">{cleanResult?.llm_model || 'N/A'}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-[var(--text-secondary)]">Mode</span>
                          <span className="font-mono text-[var(--text-primary)]">{modeUsed || 'N/A'}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-[var(--text-secondary)]">Duration</span>
                          <span className="font-mono text-[var(--text-primary)]">{(cleanDuration / 1000).toFixed(1)}s</span>
                        </div>
                      </div>

                      {/* LLM Mappings — what AI decided */}
                      {cleanCode && (() => {
                        try {
                          const parsed = JSON.parse(cleanCode);
                          const entityMaps = parsed.entity_mappings || {};
                          const catMaps = parsed.categorical_rules || {};
                          const formatRules = parsed.format_rules || {};
                          const hasContent = Object.keys(entityMaps).length > 0 || Object.keys(catMaps).length > 0;

                          if (!hasContent) return (
                            <p className="text-xs text-[var(--text-tertiary)]">No mappings generated (engine_only mode).</p>
                          );

                          return (
                            <div className="space-y-2">
                              {Object.keys(entityMaps).length > 0 && (
                                <div>
                                  <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">Entity Mappings</p>
                                  {Object.entries(entityMaps).map(([colKey, mapping]) => (
                                    <div key={colKey} className="mb-2">
                                      <p className="text-xs text-[var(--brand-600)] font-mono">{colKey}</p>
                                      <div className="ml-2 space-y-0.5">
                                        {Object.entries(mapping).map(([from, to]) => (
                                          <div key={from} className="text-xs text-[var(--text-primary)]">
                                            <span className="text-red-500/70 line-through">{from}</span>
                                            <span className="text-[var(--text-tertiary)] mx-1">&rarr;</span>
                                            <span className="text-emerald-600 font-medium">{to}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {Object.keys(catMaps).length > 0 && (
                                <div>
                                  <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">Category Rules</p>
                                  {Object.entries(catMaps).map(([colKey, mapping]) => (
                                    <div key={colKey} className="mb-2">
                                      <p className="text-xs text-[var(--brand-600)] font-mono">{colKey}</p>
                                      <div className="ml-2 space-y-0.5">
                                        {Object.entries(mapping).map(([from, to]) => (
                                          <div key={from} className="text-xs text-[var(--text-primary)]">
                                            <span className="text-red-500/70 line-through">{from}</span>
                                            <span className="text-[var(--text-tertiary)] mx-1">&rarr;</span>
                                            <span className="text-emerald-600 font-medium">{to}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {formatRules && Object.keys(formatRules).length > 0 && (
                                <div>
                                  <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">Format Rules</p>
                                  <pre className="text-xs font-mono text-[var(--text-primary)] bg-[var(--bg-secondary)] rounded p-2 overflow-auto max-h-24">
                                    {JSON.stringify(formatRules, null, 2)}
                                  </pre>
                                </div>
                              )}
                            </div>
                          );
                        } catch {
                          // Fallback: show raw JSON
                          return (
                            <pre className="text-xs bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg p-3 overflow-auto max-h-48 font-mono text-[var(--text-primary)]">
                              {cleanCode}
                            </pre>
                          );
                        }
                      })()}

                      {/* Engine Actions Log */}
                      {cleanResult?.stdout && (
                        <div>
                          <p className="text-xs font-medium text-[var(--text-secondary)] mb-1">Engine Actions</p>
                          <pre className="text-xs bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg p-3 overflow-auto max-h-36 font-mono text-[var(--text-primary)]">
                            {cleanResult.stdout}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-600 break-words">{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Right Panel */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {phase === 'agent' ? (
            <AgentProgress
              state={agentState}
              scrollRef={agentScrollRef}
              summaryRef={summaryScrollRef}
              onDownload={(id) => {
                const a = document.createElement('a');
                a.href = `${ML_API}/agent/mbr/download/${id}`;
                a.download = `MBR_${fileName.replace(/\.\w+$/, '')}.xlsx`;
                a.click();
              }}
            />
          ) : phase === 'idle' || phase === 'uploading' ? (
            <div className="flex-1 flex items-center justify-center text-[var(--text-tertiary)]">
              <div className="text-center">
                <Table2 size={40} className="mx-auto mb-2 opacity-30" />
                <p className="text-xs">Upload a file to preview data</p>
              </div>
            </div>
          ) : sheets ? (
            <>
              {/* Toolbar: view toggle + sheet tabs */}
              <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border-primary)] flex-shrink-0 overflow-x-auto">
                {/* Raw / Cleaned toggle */}
                {phase === 'complete' && cleanedTables.length > 0 && (
                  <div className="flex rounded-md border border-[var(--border-primary)] overflow-hidden flex-shrink-0">
                    <button onClick={() => setViewMode('raw')}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                        viewMode === 'raw'
                          ? 'bg-[var(--brand-500)]/10 text-[var(--brand-600)]'
                          : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)]'}`}>
                      Raw
                    </button>
                    <button onClick={() => setViewMode('cleaned')}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                        viewMode === 'cleaned'
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)]'}`}>
                      Cleaned
                    </button>
                  </div>
                )}

                {/* Sheet tabs */}
                {viewMode === 'raw' ? (
                  sheetNames.length > 1 && sheetNames.map((name) => (
                    <button key={name} onClick={() => setActiveSheet(name)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                        name === activeSheet
                          ? 'bg-[var(--brand-500)]/10 text-[var(--brand-600)]'
                          : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}>
                      {name} ({sheets[name]?.length || 0})
                    </button>
                  ))
                ) : (
                  cleanedTables.map((t) => (
                    <button key={t.label} onClick={() => setActiveCleanedSheet(t.label)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors flex-shrink-0 ${
                        t.label === activeCleanedSheet
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}>
                      {t.label} ({t.data.length})
                    </button>
                  ))
                )}
              </div>

              {/* Data table */}
              <div className="flex-1 overflow-auto p-4">
                {viewMode === 'raw' ? (
                  columns.length > 0 ? (
                    <DataTable columns={columns} rows={previewRows} totalRows={currentSheetData.length} />
                  ) : (
                    <p className="text-xs text-[var(--text-tertiary)]">This sheet is empty.</p>
                  )
                ) : (
                  activeCleanedCols.length > 0 ? (
                    <DataTable columns={activeCleanedCols} rows={activeCleanedData.slice(0, 50)} totalRows={activeCleanedData.length} />
                  ) : (
                    <p className="text-xs text-[var(--text-tertiary)]">No cleaned data available. Check the summary on the left.</p>
                  )
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Agent event reducer ──────────────────────────────────────────────────────

const AGENT_TOOL_META = {
  data_cleaning:     { icon: '\uD83E\uDDF9', label: 'Data Cleaning',      color: '#6366f1' },
  kpi_calculation:   { icon: '\uD83D\uDCCA', label: 'KPI Calculation',    color: '#0ea5e9' },
  margin_analysis:   { icon: '\uD83D\uDCB0', label: 'Margin Analysis',    color: '#10b981' },
  variance_analysis: { icon: '\uD83C\uDFAF', label: 'Variance Analysis',  color: '#f59e0b' },
  anomaly_detection: { icon: '\uD83D\uDD0D', label: 'Anomaly Detection',  color: '#ef4444' },
  inventory_health:  { icon: '\uD83D\uDCE6', label: 'Inventory Health',   color: '#8b5cf6' },
  supplier_analysis: { icon: '\uD83D\uDE9A', label: 'Supplier Analysis',  color: '#14b8a6' },
  expense_analysis:  { icon: '\uD83D\uDCB3', label: 'Expense Analysis',   color: '#f97316' },
  report_generation: { icon: '\uD83D\uDCC4', label: 'Report Generation',  color: '#8b5cf6' },
};

function reduceAgentEvent(prev, event) {
  const t = event.type;
  if (!t) return prev;

  switch (t) {
    case 'plan_start':
      return { ...prev, phase: 'planning' };

    case 'plan_done':
      return {
        ...prev,
        phase: 'executing',
        plan: event.tools || [],
        reasoning: event.reasoning || '',
        steps: (event.tools || []).map(id => ({
          tool_id: id, description: '', status: 'pending', thinking: [], findings: [],
        })),
        currentToolIndex: -1,
      };

    case 'tool_start': {
      const idx = prev.steps.findIndex(s => s.tool_id === event.tool_id);
      if (idx === -1) return prev;
      const steps = [...prev.steps];
      steps[idx] = { ...steps[idx], status: 'running', description: event.description || '' };
      return { ...prev, steps, currentToolIndex: idx };
    }

    case 'tool_thinking': {
      const idx = prev.steps.findIndex(s => s.tool_id === event.tool_id);
      if (idx === -1) return prev;
      const steps = [...prev.steps];
      steps[idx] = { ...steps[idx], thinking: [...steps[idx].thinking, event.detail] };
      return { ...prev, steps };
    }

    case 'tool_finding': {
      const idx = prev.steps.findIndex(s => s.tool_id === event.tool_id);
      if (idx === -1) return prev;
      const steps = [...prev.steps];
      steps[idx] = { ...steps[idx], findings: [...steps[idx].findings, event.finding] };
      return { ...prev, steps };
    }

    case 'tool_done': {
      const idx = prev.steps.findIndex(s => s.tool_id === event.tool_id);
      if (idx === -1) return prev;
      const steps = [...prev.steps];
      steps[idx] = { ...steps[idx], status: 'success', duration_ms: event.duration_ms };
      return { ...prev, steps };
    }

    case 'tool_error': {
      const idx = prev.steps.findIndex(s => s.tool_id === event.tool_id);
      if (idx === -1) return prev;
      const steps = [...prev.steps];
      steps[idx] = { ...steps[idx], status: 'error', error: event.error };
      return { ...prev, steps };
    }

    case 'synthesize_start':
      return { ...prev, phase: 'synthesizing' };

    case 'synthesize_chunk':
      return { ...prev, summaryChunks: [...prev.summaryChunks, event.text] };

    case 'synthesize_done':
      return prev;

    case 'agent_done':
      return {
        ...prev,
        phase: 'done',
        totalDuration: event.total_duration_ms,
        tablesGenerated: event.tables_generated,
        totalArtifacts: event.total_artifacts,
      };

    case 'key_tables':
      return { ...prev, keyTables: event.tables || [] };

    case 'artifacts_ready':
      return { ...prev, downloadId: event.download_id, phase: 'done' };

    case 'error':
      return { ...prev, phase: 'error', error: event.message };

    default:
      return prev;
  }
}


// ── Cleaning progress with live log + elapsed timer ─────────────────────────

const STAGES = [
  { id: 'profiling', label: 'Profile', icon: '1' },
  { id: 'llm', label: 'AI Rules', icon: '2' },
  { id: 'engine', label: 'Clean', icon: '3' },
  { id: 'deep_clean', label: 'AI Polish', icon: '4' },
];

function CleaningProgress({ stage, liveLog }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const stageOrder = ['profiling', 'llm', 'llm_bootstrap', 'engine', 'deep_clean', 'done'];
  const currentIdx = stageOrder.indexOf(stage);
  const isBootstrap = stage === 'llm_bootstrap';

  return (
    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-3">
      {/* Header with timer */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="text-blue-500 animate-spin" />
          <span className="text-xs font-medium text-blue-600">
            {isBootstrap ? 'Building rule store (first time)...' :
             stage === 'profiling' ? 'Analyzing data...' :
             stage === 'llm' ? 'AI generating rules...' :
             stage === 'engine' ? 'Applying rules...' :
             stage === 'deep_clean' ? 'AI deep cleaning...' :
             'Working...'}
          </span>
        </div>
        <span className="text-xs font-mono text-[var(--text-tertiary)] tabular-nums">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
        </span>
      </div>

      {/* Step indicators */}
      <div className="flex gap-2">
        {STAGES.map((s, i) => {
          const isActive = (s.id === 'llm' && (stage === 'llm' || stage === 'llm_bootstrap')) || s.id === stage;
          const isDone = currentIdx > stageOrder.indexOf(s.id);
          return (
            <div key={s.id} className="flex-1">
              <div className={`flex items-center gap-1.5 mb-1 ${
                isActive ? 'text-blue-600' : isDone ? 'text-emerald-600' : 'text-[var(--text-tertiary)]'
              }`}>
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  isDone ? 'bg-emerald-500 text-white' :
                  isActive ? 'bg-blue-500 text-white' :
                  'bg-[var(--border-primary)] text-[var(--text-tertiary)]'
                }`}>
                  {isDone ? '\u2713' : s.icon}
                </div>
                <span className="text-[10px] font-medium">{s.label}</span>
              </div>
              <div className={`h-1 rounded-full ${
                isDone ? 'bg-emerald-500' :
                isActive ? 'bg-blue-500 animate-pulse' :
                'bg-[var(--border-primary)]'
              }`} />
            </div>
          );
        })}
      </div>

      {/* Live log */}
      {liveLog.length > 0 && (
        <div className="max-h-48 overflow-y-auto border-t border-[var(--border-primary)] pt-2 space-y-0.5">
          {liveLog.map((entry, i) => (
            <p key={i} className={`text-[11px] leading-relaxed font-mono ${
              entry.msg.startsWith('ERROR') ? 'text-red-500 font-medium' :
              entry.msg.startsWith('  ') ? 'text-[var(--text-tertiary)]' :
              'text-[var(--text-secondary)]'
            }`}>
              {entry.msg}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Markdown renderer for synthesizer output ─────────────────────────────────

function renderMarkdown(text) {
  return text
    .replace(/\*\*\[([^\]]+)\]\*\*/g,
      '<span style="font-weight:700;color:var(--brand-500)">[$1]</span>')
    .replace(/\*\*([^*]+)\*\*/g,
      '<span style="font-weight:700;color:var(--text-primary)">$1</span>')
    .replace(/^## (.+)$/gm,
      '<h3 style="font-size:13px;font-weight:700;color:var(--brand-400);margin:14px 0 6px">$1</h3>')
    .replace(/^(\d+)\. /gm,
      '<span style="color:var(--brand-500);font-weight:700">$1.</span> ')
    .replace(/^- /gm, '<span style="color:var(--brand-500)">\u2022</span> ')
    .replace(/\n/g, '<br/>');
}


// ── MBR Agent Progress Panel ──────────────────────────────────────────────────

function AgentProgress({ state, scrollRef, summaryRef, onDownload }) {
  const summary = state.summaryChunks.join('');
  const visibleSteps = state.steps.filter(s => s.status !== 'pending');

  return (
    <div className="flex flex-col gap-3 h-full overflow-y-auto p-4">
      {/* Planning */}
      {state.phase !== 'idle' && (
        <div className="rounded-lg border border-indigo-500/15 bg-indigo-500/5 p-3">
          <div className="flex items-center gap-2 mb-1.5">
            {state.phase === 'planning'
              ? <Loader2 size={13} className="text-indigo-400 animate-spin" />
              : <CheckCircle size={13} className="text-emerald-500" />}
            <span className="text-xs font-semibold text-indigo-300">Planning</span>
          </div>
          {state.reasoning && (
            <p className="text-xs text-[var(--text-tertiary)] ml-5 leading-relaxed">{state.reasoning}</p>
          )}
          {state.plan.length > 0 && (
            <div className="flex gap-1.5 ml-5 mt-2 flex-wrap">
              {state.plan.map(id => {
                const meta = AGENT_TOOL_META[id] || { icon: '\u2699\uFE0F', label: id };
                const step = state.steps.find(s => s.tool_id === id);
                const done = step?.status === 'success';
                const running = step?.status === 'running';
                const err = step?.status === 'error';
                return (
                  <span key={id} className={`text-[10px] px-2 py-0.5 rounded-md font-medium border transition-all ${
                    done ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                    running ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/25' :
                    err ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                    'bg-[var(--bg-secondary)] text-[var(--text-tertiary)] border-[var(--border-primary)]'
                  }`}>
                    {meta.icon} {meta.label}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tool Steps */}
      {visibleSteps.length > 0 && (
        <div ref={scrollRef} className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)]/40 overflow-y-auto max-h-[360px]">
          {visibleSteps.map(step => {
            const meta = AGENT_TOOL_META[step.tool_id] || { icon: '\u2699\uFE0F', label: step.tool_id, color: '#94a3b8' };
            const isActive = step.status === 'running';
            const hasContent = step.thinking.length > 0 || step.findings.length > 0;
            return (
              <div key={step.tool_id} className={`px-3 py-2.5 border-b border-[var(--border-primary)] last:border-b-0 transition-colors ${
                isActive ? 'bg-indigo-500/5' : ''}`}>
                <div className="flex items-center gap-2">
                  {step.status === 'running' && <Loader2 size={12} className="animate-spin" style={{ color: meta.color }} />}
                  {step.status === 'success' && <CheckCircle size={12} className="text-emerald-500" />}
                  {step.status === 'error' && <AlertCircle size={12} className="text-red-500" />}
                  <span className="text-xs font-medium text-[var(--text-primary)]">
                    {meta.icon} {meta.label}
                  </span>
                  {step.duration_ms != null && (
                    <span className="text-[10px] font-mono text-[var(--text-tertiary)] ml-auto">
                      {(step.duration_ms / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                {hasContent && (
                  <div className="ml-5 mt-1.5 space-y-0.5">
                    {step.thinking.map((t, i) => (
                      <p key={`t${i}`} className="text-[11px] italic text-[var(--text-tertiary)] leading-relaxed"
                        style={{ borderLeft: `2px solid ${meta.color}33`, paddingLeft: 8 }}>
                        {t}
                      </p>
                    ))}
                    {step.findings.map((f, i) => (
                      <p key={`f${i}`} className="text-[11px] font-medium text-[var(--text-secondary)] leading-relaxed"
                        style={{ borderLeft: `2px solid ${meta.color}88`, paddingLeft: 8 }}>
                        {f}
                      </p>
                    ))}
                  </div>
                )}
                {step.error && (
                  <p className="ml-5 mt-1 text-[11px] text-red-400">{step.error}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Synthesizer */}
      {(state.phase === 'synthesizing' || (state.phase === 'done' && summary)) && (
        <div className="rounded-lg border border-indigo-500/12 bg-[var(--bg-secondary)]/60 overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--border-primary)] flex items-center gap-2">
            {state.phase === 'synthesizing'
              ? <Loader2 size={12} className="text-indigo-400 animate-spin" />
              : <CheckCircle size={12} className="text-emerald-500" />}
            <span className="text-xs font-semibold text-indigo-300">Executive Summary</span>
            {state.phase === 'synthesizing' && (
              <span className="text-[10px] text-indigo-400 ml-auto animate-pulse">streaming...</span>
            )}
          </div>
          <div ref={summaryRef}
            className="px-4 py-3 max-h-[400px] overflow-y-auto text-xs leading-relaxed text-[var(--text-primary)]"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
          />
        </div>
      )}

      {/* Done footer */}
      {state.phase === 'done' && (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 flex items-center justify-between">
          <span className="text-xs font-medium text-emerald-400">
            Analysis complete {state.tablesGenerated != null && `\u00B7 ${state.tablesGenerated} key tables`}
          </span>
          <div className="flex items-center gap-3">
            {state.totalDuration != null && (
              <span className="text-[10px] font-mono text-[var(--text-tertiary)]">
                {(state.totalDuration / 1000).toFixed(1)}s
              </span>
            )}
            {state.downloadId && (
              <button onClick={() => onDownload(state.downloadId)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 transition-colors">
                <Download size={12} /> Download MBR
              </button>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {state.phase === 'error' && state.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle size={13} className="text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-red-400 break-words">{state.error}</p>
          </div>
        </div>
      )}
    </div>
  );
}


// ── Reusable data table ─────────────────────────────────────────────────────

function DataTable({ columns, rows, totalRows }) {
  return (
    <div className="border border-[var(--border-primary)] rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr className="bg-[var(--bg-secondary)]">
              <th className="px-2 py-1.5 text-left font-medium text-[var(--text-tertiary)] border-b border-[var(--border-primary)] w-8 sticky left-0 bg-[var(--bg-secondary)]">#</th>
              {columns.map((col) => (
                <th key={col} className="px-2 py-1.5 text-left font-medium text-[var(--text-secondary)] border-b border-[var(--border-primary)] whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-[var(--border-primary)] last:border-b-0 hover:bg-[var(--bg-secondary)]/50">
                <td className="px-2 py-1 text-[var(--text-tertiary)] sticky left-0 bg-[var(--bg-primary)]">{i + 1}</td>
                {columns.map((col) => (
                  <td key={col} className="px-2 py-1 text-[var(--text-primary)] whitespace-nowrap max-w-[180px] truncate">
                    {row[col] !== null && row[col] !== undefined ? String(row[col]) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalRows > rows.length && (
        <div className="px-2 py-1.5 text-xs text-[var(--text-tertiary)] bg-[var(--bg-secondary)] border-t border-[var(--border-primary)]">
          Showing {rows.length} of {totalRows.toLocaleString()} rows
        </div>
      )}
    </div>
  );
}
