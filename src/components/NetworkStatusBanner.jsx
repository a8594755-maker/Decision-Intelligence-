import { useSystemHealth } from '../hooks/useSystemHealth';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Wifi, WifiOff } from 'lucide-react';

/**
 * Fixed-top banner that shows when any backend service is offline.
 * Auto-hides when all services are online.
 */
export default function NetworkStatusBanner() {
  const { health, refresh } = useSystemHealth();
  const { t } = useTranslation();

  const offlineServices = Object.entries(health)
    .filter(([, status]) => status === 'offline')
    .map(([name]) => name);

  if (offlineServices.length === 0) return null;

  return (
    <div className="sticky top-0 z-40 flex items-center justify-between gap-3 px-4 py-2 text-sm font-medium bg-amber-50 text-amber-900 border-b border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800">
      <div className="flex items-center gap-2">
        <WifiOff className="w-4 h-4 flex-shrink-0" />
        <span>
          {t('common.networkOffline')}: {offlineServices.join(', ')}
        </span>
      </div>
      <button
        onClick={refresh}
        className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-amber-200 hover:bg-amber-300 dark:bg-amber-800 dark:hover:bg-amber-700 transition-colors"
      >
        <RefreshCw className="w-3 h-3" />
        {t('common.refresh')}
      </button>
    </div>
  );
}
