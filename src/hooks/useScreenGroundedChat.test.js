// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useScreenGroundedChat from './useScreenGroundedChat';

describe('useScreenGroundedChat', () => {
  it('starts with no selection', () => {
    const { result } = renderHook(() => useScreenGroundedChat());
    expect(result.current.selection).toBeNull();
    expect(result.current.selectionHistory).toEqual([]);
    expect(result.current.buildContextPatch()).toBeNull();
    expect(result.current.buildSelectionPromptText()).toBe('');
  });

  it('captures topology node selection', () => {
    const { result } = renderHook(() => useScreenGroundedChat());

    act(() => {
      result.current.handleTopologySelect({
        kind: 'node',
        raw: {
          id: 'supplier_1',
          label: 'Supplier ABC',
          type: 'supplier',
          metrics: { lead_time: 14 },
        },
      });
    });

    expect(result.current.selection).toBeTruthy();
    expect(result.current.selection.source).toBe('topology');
    expect(result.current.selection.kind).toBe('node');
    expect(result.current.selection.label).toBe('Supplier ABC');
    expect(result.current.selection.entity_type).toBe('supplier');
  });

  it('captures risk row selection', () => {
    const { result } = renderHook(() => useScreenGroundedChat());

    act(() => {
      result.current.handleRiskSelect({
        id: 'r1',
        item: 'MAT-001',
        plantId: 'P1',
        riskLevel: 'high',
        profitAtRisk: 15000,
        daysToStockout: 5,
      });
    });

    expect(result.current.selection.source).toBe('risk');
    expect(result.current.selection.material_code).toBe('MAT-001');
    expect(result.current.selection.plant_id).toBe('P1');
    expect(result.current.selection.risk_level).toBe('high');
    expect(result.current.selection.metrics.days_to_stockout).toBe(5);
  });

  it('captures chart point selection', () => {
    const { result } = renderHook(() => useScreenGroundedChat());

    act(() => {
      result.current.handleChartSelect({
        label: 'Week 3',
        value: 1500,
        series: 'demand',
        chart_type: 'forecast_chart',
      });
    });

    expect(result.current.selection.source).toBe('chart');
    expect(result.current.selection.label).toBe('Week 3');
    expect(result.current.selection.value).toBe(1500);
  });

  it('captures plan row selection', () => {
    const { result } = renderHook(() => useScreenGroundedChat());

    act(() => {
      result.current.handlePlanRowSelect({
        material_code: 'MAT-002',
        plant_id: 'P2',
        order_qty: 500,
        supplier_id: 'SUP-01',
      });
    });

    expect(result.current.selection.source).toBe('plan_table');
    expect(result.current.selection.material_code).toBe('MAT-002');
    expect(result.current.selection.supplier_id).toBe('SUP-01');
  });

  it('maintains selection history (max 10)', () => {
    const { result } = renderHook(() => useScreenGroundedChat());

    act(() => {
      for (let i = 0; i < 12; i++) {
        result.current.handleRiskSelect({
          id: `r${i}`,
          item: `MAT-${i}`,
          plantId: 'P1',
          riskLevel: 'low',
        });
      }
    });

    expect(result.current.selectionHistory).toHaveLength(10);
    // Most recent should be first
    expect(result.current.selectionHistory[0].material_code).toBe('MAT-11');
  });

  it('builds context patch from selection', () => {
    const { result } = renderHook(() => useScreenGroundedChat());

    act(() => {
      result.current.handleRiskSelect({
        id: 'r1',
        item: 'MAT-001',
        plantId: 'P1',
        riskLevel: 'critical',
      });
    });

    const patch = result.current.buildContextPatch();
    expect(patch).toBeTruthy();
    expect(patch.screen_selection.source).toBe('risk');
    expect(patch.screen_selection.material_code).toBe('MAT-001');
    expect(patch.screen_selection.risk_level).toBe('critical');
  });

  it('builds prompt text from risk selection', () => {
    const { result } = renderHook(() => useScreenGroundedChat());

    act(() => {
      result.current.handleRiskSelect({
        item: 'MAT-001',
        plantId: 'P1',
        riskLevel: 'high',
        daysToStockout: 3,
      });
    });

    const text = result.current.buildSelectionPromptText();
    expect(text).toContain('MAT-001');
    expect(text).toContain('high');
    expect(text).toContain('Days to stockout: 3');
  });

  it('builds prompt text from topology selection', () => {
    const { result } = renderHook(() => useScreenGroundedChat());

    act(() => {
      result.current.handleTopologySelect({
        kind: 'edge',
        raw: { id: 'e1', label: 'SUP→PLANT', type: 'supply_link' },
      });
    });

    const text = result.current.buildSelectionPromptText();
    expect(text).toContain('SUP→PLANT');
    expect(text).toContain('edge');
  });

  it('clears selection', () => {
    const { result } = renderHook(() => useScreenGroundedChat());

    act(() => {
      result.current.handleRiskSelect({ item: 'MAT-001', plantId: 'P1' });
    });
    expect(result.current.selection).toBeTruthy();

    act(() => {
      result.current.clearSelection();
    });
    expect(result.current.selection).toBeNull();
  });

  it('ignores null selections', () => {
    const { result } = renderHook(() => useScreenGroundedChat());

    act(() => {
      result.current.handleTopologySelect(null);
      result.current.handleTopologySelect({ kind: 'node', raw: null });
      result.current.handleRiskSelect(null);
      result.current.handleChartSelect(null);
    });

    expect(result.current.selection).toBeNull();
    expect(result.current.selectionHistory).toHaveLength(0);
  });
});
