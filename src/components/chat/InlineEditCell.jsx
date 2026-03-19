/**
 * InlineEditCell.jsx
 *
 * Cell component for Plan Studio Data tab that toggles between
 * display and edit mode. Supports text, number, and select field types.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Pencil, Check, X, Loader2 } from 'lucide-react';

export default function InlineEditCell({
  value,
  fieldConfig,
  onSave,
  disabled = false,
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(null); // 'success' | 'error' | null
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (inputRef.current.select) inputRef.current.select();
    }
  }, [editing]);

  const startEdit = useCallback(() => {
    if (disabled || saving) return;
    setEditValue(value ?? '');
    setEditing(true);
    setFlash(null);
  }, [disabled, saving, value]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setEditValue(value);
  }, [value]);

  const commitEdit = useCallback(async () => {
    const newVal = fieldConfig?.type === 'number' ? Number(editValue) : editValue;
    if (newVal === value) {
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      await onSave(newVal);
      setEditing(false);
      setFlash('success');
      setTimeout(() => setFlash(null), 1200);
    } catch {
      setFlash('error');
      setTimeout(() => setFlash(null), 2000);
    } finally {
      setSaving(false);
    }
  }, [editValue, value, fieldConfig, onSave]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  }, [commitEdit, cancelEdit]);

  const displayValue = value != null ? String(value) : '—';

  const flashClass = flash === 'success'
    ? 'bg-green-50 dark:bg-green-900/20'
    : flash === 'error'
      ? 'bg-red-50 dark:bg-red-900/20'
      : '';

  // ── Edit mode ────────────────────────────────────────────────────────────

  if (editing) {
    const inputClasses = 'w-full px-1.5 py-0.5 text-sm border border-blue-400 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white dark:bg-gray-800 dark:text-gray-100';

    let input;
    if (fieldConfig?.type === 'select') {
      input = (
        <select
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className={inputClasses}
          disabled={saving}
        >
          {(fieldConfig.options || []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );
    } else {
      input = (
        <input
          ref={inputRef}
          type={fieldConfig?.type === 'number' ? 'number' : 'text'}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitEdit}
          className={inputClasses}
          disabled={saving}
          min={fieldConfig?.min}
        />
      );
    }

    return (
      <div className="flex items-center gap-1">
        {input}
        {saving ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
        ) : (
          <>
            <button onMouseDown={(e) => { e.preventDefault(); commitEdit(); }} className="p-0.5 text-green-600 hover:text-green-700" title="Save">
              <Check className="w-3.5 h-3.5" />
            </button>
            <button onMouseDown={(e) => { e.preventDefault(); cancelEdit(); }} className="p-0.5 text-gray-400 hover:text-gray-600" title="Cancel">
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    );
  }

  // ── Display mode ─────────────────────────────────────────────────────────

  return (
    <div
      className={`group flex items-center gap-1 transition-colors duration-300 rounded px-1 ${flashClass}`}
    >
      <span className="text-sm truncate">{displayValue}</span>
      {!disabled && (
        <button
          onClick={startEdit}
          className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-blue-500 transition-opacity"
          title={`Edit ${fieldConfig?.label || ''}`}
        >
          <Pencil className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
