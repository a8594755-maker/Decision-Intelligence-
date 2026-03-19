/**
 * BOMDataViewLite — Thin wrapper around BOMWidget in live mode.
 * Replaces the legacy BOMDataView (406 lines → ~30 lines).
 *
 * Drop-in replacement: same props interface as BOMDataView.
 */

import React from 'react';
import BOMWidget from '../components/canvas/widgets/BOMWidget';

const BOMDataViewLite = ({ user, addNotification: _addNotification, globalDataSource }) => {
  return (
    <div className="h-full">
      <BOMWidget
        mode="live"
        user={user}
        globalDataSource={globalDataSource}
      />
    </div>
  );
};

export default BOMDataViewLite;
