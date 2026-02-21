import { describe, expect, it } from 'vitest';
import { classifySheet } from './sheetClassifier';
import { ruleBasedMapping } from './aiMappingHelper';
import { getRequiredMappingStatus } from './requiredMappingStatus';

const M5_HEADERS = [
  'week_start',
  'week_end',
  'wm_yr_wk',
  'week_index',
  'state_id',
  'store_id',
  'cat_id',
  'dept_id',
  'item_id',
  'series_id',
  'units_sold',
  'sell_price',
  'event_flag',
  'snap_flag',
  'supplier_id',
  'lead_time_days',
  'demand_mean_8w',
  'demand_std_8w',
  'on_hand_start',
  'receipts',
  'revenue',
  'service_level',
  'z_value',
  'safety_stock_units',
  'reorder_point_units',
  'on_hand_end_units',
  'stockout_flag',
  'days_to_stockout',
  'forecast_4w_avg_units'
];

const M5_SAMPLE_ROWS = [
  {
    week_start: '2016-01-31',
    wm_yr_wk: '2016-W05',
    store_id: 'CA_1',
    item_id: 'HOBBIES_1_001',
    units_sold: 13,
    sell_price: 8.26
  },
  {
    week_start: '2016-02-07',
    wm_yr_wk: '2016-W06',
    store_id: 'CA_1',
    item_id: 'HOBBIES_1_001',
    units_sold: 11,
    sell_price: 8.26
  }
];

describe('M5 mapping compatibility', () => {
  it('classifies M5-style weekly demand data as demand_fg', () => {
    const classification = classifySheet({
      sheetName: 'Decision-Intelligence_Data',
      headers: M5_HEADERS,
      sampleRows: M5_SAMPLE_ROWS
    });

    expect(classification.suggestedType).toBe('demand_fg');
    expect(classification.confidence).toBeGreaterThan(0.5);
  });

  it('builds complete required-field mapping for demand_fg from M5 headers', () => {
    const suggestions = ruleBasedMapping(M5_HEADERS, 'demand_fg');
    const mapping = {};

    suggestions
      .filter((item) => item.target && item.confidence >= 0.7)
      .forEach((item) => {
        mapping[item.source] = item.target;
      });

    const status = getRequiredMappingStatus({
      uploadType: 'demand_fg',
      columns: M5_HEADERS,
      columnMapping: mapping
    });

    expect(mapping.item_id).toBe('material_code');
    expect(mapping.store_id).toBe('plant_id');
    expect(mapping.units_sold).toBe('demand_qty');
    expect(
      mapping.week_start === 'time_bucket' ||
      mapping.wm_yr_wk === 'time_bucket' ||
      mapping.wm_yr_wk === 'week_bucket'
    ).toBe(true);
    expect(status.isComplete).toBe(true);
    expect(status.missingRequired).toEqual([]);
  });
});
