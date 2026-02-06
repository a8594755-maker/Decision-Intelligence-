/**
 * Sync a tab (or similar) value with URL search params.
 * On mount: read param from URL; on setValue: update state and replaceState.
 * Ensures route + tab survive refresh and tab switch.
 */
import { useState, useEffect, useCallback } from 'react';
import { getSearchParams, updateUrlSearch } from '../utils/router';

/**
 * @param {string} defaultTab - Default when URL has no param
 * @param {string} paramKey - Query key (default 'tab')
 * @param {string[]} validValues - If provided, only use URL value when it's in this list
 * @returns {[string, (v: string) => void]}
 */
export function useUrlTabState(defaultTab, paramKey = 'tab', validValues = null) {
  const readFromUrl = useCallback(() => {
    const params = getSearchParams();
    const raw = params[paramKey];
    if (validValues && raw && validValues.includes(raw)) return raw;
    if (!validValues && raw) return raw;
    return defaultTab;
  }, [paramKey, defaultTab, validValues]);

  const [tab, setTabState] = useState(() => readFromUrl());

  // Sync from URL when user uses browser back/forward (popstate)
  useEffect(() => {
    const handlePopState = () => {
      setTabState(readFromUrl());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [readFromUrl]);

  const setTab = useCallback((value) => {
    setTabState(value);
    updateUrlSearch({ [paramKey]: value === defaultTab ? '' : value });
  }, [paramKey, defaultTab]);

  return [tab, setTab];
}
