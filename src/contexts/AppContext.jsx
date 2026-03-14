import { createContext, useContext, useState, useEffect } from 'react';

const AppContext = createContext(null);

const WS_STORAGE_KEY = 'di_active_workspace';

export function AppProvider({ children }) {
  const [darkMode, setDarkMode] = useState(false);
  const [globalDataSource, setGlobalDataSource] = useState('local'); // 'local' | 'sap'
  const [activeWorkspace, setActiveWorkspaceRaw] = useState(() => {
    try { return localStorage.getItem(WS_STORAGE_KEY) || 'ai_employee'; }
    catch { return 'ai_employee'; }
  }); // 'di' | 'ai_employee'

  function setActiveWorkspace(ws) {
    setActiveWorkspaceRaw(ws);
    try { localStorage.setItem(WS_STORAGE_KEY, ws); } catch { /* */ }
  }

  useEffect(() => {
    if (darkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [darkMode]);

  const value = { darkMode, setDarkMode, globalDataSource, setGlobalDataSource, activeWorkspace, setActiveWorkspace };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
};
