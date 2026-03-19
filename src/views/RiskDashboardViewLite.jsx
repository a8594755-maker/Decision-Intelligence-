/**
 * RiskDashboardViewLite — Thin wrapper around RiskWidget in live mode.
 * Replaces the legacy RiskDashboardView (1,356 lines → ~30 lines).
 *
 * Drop-in replacement: same props interface as RiskDashboardView.
 */

import React from 'react';
import RiskWidget from '../components/canvas/widgets/RiskWidget';

const RiskDashboardViewLite = ({ user, addNotification: _addNotification, globalDataSource }) => {
  return (
    <div className="h-full">
      <RiskWidget
        mode="live"
        user={user}
        globalDataSource={globalDataSource}
      />
    </div>
  );
};

export default RiskDashboardViewLite;
