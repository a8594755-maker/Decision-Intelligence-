import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAlertMonitor, buildAlertChatMessage } from './alertMonitorService';

// Mock proactiveAlertService
vi.mock('./proactiveAlertService', () => ({
  generateAlerts: vi.fn(({ riskScores }) => ({
    alerts: riskScores.map((r, i) => ({
      alert_id: `alert_${i}`,
      alert_type: 'stockout_risk',
      severity: 'high',
      material_code: r.material_code,
      plant_id: r.plant_id,
      title: `Stockout risk: ${r.material_code}`,
      message: 'Test alert',
      impact_score: 1000 + i,
    })),
    summary: { total_alerts: riskScores.length },
  })),
}));

describe('alertMonitorService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('createAlertMonitor', () => {
    it('creates a monitor with start/stop/evaluateNow', () => {
      const monitor = createAlertMonitor({
        userId: 'user1',
        onAlertsBatch: vi.fn(),
        loadRiskState: vi.fn().mockResolvedValue({ riskScores: [], stockoutData: [] }),
      });

      expect(monitor.start).toBeDefined();
      expect(monitor.stop).toBeDefined();
      expect(monitor.evaluateNow).toBeDefined();
      expect(monitor.isRunning).toBeDefined();
    });

    it('evaluateNow calls loadRiskState and onAlertsBatch', async () => {
      const onAlertsBatch = vi.fn();
      const loadRiskState = vi.fn().mockResolvedValue({
        riskScores: [
          { entity_type: 'supplier_material', material_code: 'MAT1', plant_id: 'P1', risk_score: 80, metrics: {} },
        ],
        stockoutData: [],
      });

      const monitor = createAlertMonitor({
        userId: 'user1',
        onAlertsBatch,
        loadRiskState,
      });

      await monitor.evaluateNow();

      expect(loadRiskState).toHaveBeenCalledWith('user1');
      expect(onAlertsBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          alerts: expect.arrayContaining([
            expect.objectContaining({ material_code: 'MAT1' }),
          ]),
        })
      );
    });

    it('deduplicates alerts within the window', async () => {
      const onAlertsBatch = vi.fn();
      const loadRiskState = vi.fn().mockResolvedValue({
        riskScores: [
          { entity_type: 'supplier_material', material_code: 'MAT1', plant_id: 'P1', risk_score: 80, metrics: {} },
        ],
        stockoutData: [],
      });

      const monitor = createAlertMonitor({
        userId: 'user1',
        onAlertsBatch,
        loadRiskState,
        config: { dedup_window_ms: 60000 },
      });

      await monitor.evaluateNow();
      expect(onAlertsBatch).toHaveBeenCalledTimes(1);

      // Same alert within dedup window — should NOT emit again
      await monitor.evaluateNow();
      expect(onAlertsBatch).toHaveBeenCalledTimes(1);

      // Advance past dedup window
      vi.advanceTimersByTime(61000);
      await monitor.evaluateNow();
      expect(onAlertsBatch).toHaveBeenCalledTimes(2);
    });

    it('limits alerts per push to max_alerts_per_push', async () => {
      const onAlertsBatch = vi.fn();
      const loadRiskState = vi.fn().mockResolvedValue({
        riskScores: Array.from({ length: 20 }, (_, i) => ({
          entity_type: 'supplier_material',
          material_code: `MAT${i}`,
          plant_id: `P${i}`,
          risk_score: 80,
          metrics: {},
        })),
        stockoutData: [],
      });

      const monitor = createAlertMonitor({
        userId: 'user1',
        onAlertsBatch,
        loadRiskState,
        config: { max_alerts_per_push: 3 },
      });

      await monitor.evaluateNow();
      expect(onAlertsBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          alerts: expect.any(Array),
        })
      );
      expect(onAlertsBatch.mock.calls[0][0].alerts.length).toBeLessThanOrEqual(3);
    });

    it('does not emit when no risk data available', async () => {
      const onAlertsBatch = vi.fn();
      const loadRiskState = vi.fn().mockResolvedValue({ riskScores: [], stockoutData: [] });

      const monitor = createAlertMonitor({
        userId: 'user1',
        onAlertsBatch,
        loadRiskState,
      });

      await monitor.evaluateNow();
      expect(onAlertsBatch).not.toHaveBeenCalled();
    });

    it('start/stop controls polling', () => {
      const monitor = createAlertMonitor({
        userId: 'user1',
        onAlertsBatch: vi.fn(),
        loadRiskState: vi.fn().mockResolvedValue({ riskScores: [], stockoutData: [] }),
      });

      expect(monitor.isRunning()).toBe(false);
      monitor.start();
      expect(monitor.isRunning()).toBe(true);
      monitor.stop();
      expect(monitor.isRunning()).toBe(false);
    });
  });

  describe('buildAlertChatMessage', () => {
    it('builds a valid chat message', () => {
      const msg = buildAlertChatMessage({
        alerts: [{ alert_id: 'a1', title: 'Test' }],
        summary: { total_alerts: 1 },
      });

      expect(msg.role).toBe('system');
      expect(msg.type).toBe('proactive_alert_card');
      expect(msg.is_proactive).toBe(true);
      expect(msg.payload.alerts).toHaveLength(1);
    });
  });
});
