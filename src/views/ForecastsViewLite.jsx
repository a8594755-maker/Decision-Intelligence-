/**
 * ForecastsViewLite — Thin wrapper around ForecastWidget in live mode.
 * Replaces the legacy ForecastsView (906 lines + 6 sub-tabs → ~30 lines).
 *
 * Note: BOM explosion action stays in chat/DSV. This view only handles
 * viewing forecast results (component demands, traces, charts).
 *
 * Drop-in replacement: same props interface as ForecastsView.
 */

import React from 'react';
import ForecastWidget from '../components/canvas/widgets/ForecastWidget';

const ForecastsViewLite = ({ user, addNotification }) => {
  return (
    <div className="h-full">
      <ForecastWidget
        mode="live"
        user={user}
      />
    </div>
  );
};

export default ForecastsViewLite;
