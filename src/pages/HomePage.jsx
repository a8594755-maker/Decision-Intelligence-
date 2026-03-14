// HomePage — Thin wrapper that renders the correct home based on active workspace.
import { useApp } from '../contexts/AppContext';
import CommandCenter from './CommandCenter';
import AIEmployeeHome from './AIEmployeeHome';

export default function HomePage() {
  const { activeWorkspace } = useApp();

  if (activeWorkspace === 'di') {
    return <CommandCenter />;
  }

  return <AIEmployeeHome />;
}
