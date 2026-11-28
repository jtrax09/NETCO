import { describe, expect, it } from 'vitest';
import {
  evaluatePingLatency,
  evaluateRouterHealth,
  findNewlyDetectedRouters,
  ROUTER_AUTO_SCAN_INTERVAL_MS,
  ROUTER_RTT_ALERT_MS,
  toggleRouterIdSelection,
} from '../routerHealth.ts';

describe('evaluateRouterHealth', () => {
  it('returns HEALTHY when connected router cpu_load and memory are below thresholds', () => {
    const res = evaluateRouterHealth({
      status: 'CONNECTED',
      cpuLoad: 24,
      memoryUsedBytes: 64 * 1024 * 1024,
      memoryTotalBytes: 256 * 1024 * 1024,
    });
    expect(res.level).toBe('HEALTHY');
    expect(res.cpuState).toBe('NORMAL');
    expect(res.memState).toBe('NORMAL');
    expect(res.cpuPct).toBe(24);
    expect(res.memPct).toBe(25);
    expect(res.exceededReasons).toEqual([]);
  });

  it('returns WARNING when cpu_load reaches warning threshold (>= 75%)', () => {
    const res = evaluateRouterHealth({
      status: 'CONNECTED',
      cpuLoad: 82,
      memoryUsedBytes: 100 * 1024 * 1024,
      memoryTotalBytes: 256 * 1024 * 1024,
    });
    expect(res.level).toBe('WARNING');
    expect(res.cpuState).toBe('WARNING');
    expect(res.memState).toBe('NORMAL');
    expect(res.exceededReasons[0]).toContain('CPU load at 82%');
  });

  it('returns WARNING when memory usage reaches warning threshold (>= 80%)', () => {
    const res = evaluateRouterHealth({
      status: 'CONNECTED',
      cpuLoad: 30,
      memoryUsedBytes: 215 * 1024 * 1024,
      memoryTotalBytes: 256 * 1024 * 1024,
    });
    expect(res.level).toBe('WARNING');
    expect(res.memState).toBe('WARNING');
    expect(res.memPct).toBe(84);
    expect(res.exceededReasons[0]).toContain('Memory usage at 84%');
  });

  it('returns CRITICAL when cpu_load or memory exceeds critical threshold', () => {
    const res = evaluateRouterHealth({
      status: 'CONNECTED',
      cpuLoad: 95,
      memoryUsedBytes: 245 * 1024 * 1024,
      memoryTotalBytes: 256 * 1024 * 1024,
    });
    expect(res.level).toBe('CRITICAL');
    expect(res.cpuState).toBe('CRITICAL');
    expect(res.memState).toBe('CRITICAL');
    expect(res.exceededReasons.length).toBe(2);
  });

  it('returns OFFLINE when router is not connected', () => {
    const res = evaluateRouterHealth({
      status: 'NOT_CONNECTED',
      cpuLoad: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
    });
    expect(res.level).toBe('OFFLINE');
  });
});

describe('evaluatePingLatency', () => {
  it('treats RTT at or below 100ms as NORMAL', () => {
    expect(ROUTER_RTT_ALERT_MS).toBe(100);
    const res = evaluatePingLatency({ reachable: true, roundTripMs: 100 });
    expect(res.level).toBe('NORMAL');
    expect(res.exceedsThreshold).toBe(false);
  });

  it('flags RTT exceeding 100ms as HIGH_LATENCY alert', () => {
    const res = evaluatePingLatency({ reachable: true, roundTripMs: 124.6 });
    expect(res.level).toBe('HIGH_LATENCY');
    expect(res.exceedsThreshold).toBe(true);
    expect(res.label).toContain('100ms');
  });

  it('returns UNREACHABLE when ping fails', () => {
    const res = evaluatePingLatency({ reachable: false, roundTripMs: null });
    expect(res.level).toBe('UNREACHABLE');
    expect(res.exceedsThreshold).toBe(false);
  });
});

describe('findNewlyDetectedRouters', () => {
  it('configures periodic auto-scan interval to exactly 5 minutes', () => {
    expect(ROUTER_AUTO_SCAN_INTERVAL_MS).toBe(300_000);
  });

  it('filters out already added, existing, duplicate, and dismissed hosts', () => {
    const discovered = [
      { host: '192.168.88.1', alreadyAdded: true },
      { host: '192.168.88.10', alreadyAdded: false },
      { host: '192.168.88.20', alreadyAdded: false },
      { host: '192.168.88.20', alreadyAdded: false },
      { host: '192.168.88.30', alreadyAdded: false },
    ];
    const existingRouters = [{ host: '192.168.88.10' }];
    const dismissedHosts = new Set(['192.168.88.30']);

    const newlyDetected = findNewlyDetectedRouters(discovered, existingRouters, dismissedHosts);
    expect(newlyDetected).toEqual([{ host: '192.168.88.20', alreadyAdded: false }]);
  });
});

describe('toggleRouterIdSelection', () => {
  it('adds and removes router IDs without mutating existing selection', () => {
    const step1 = toggleRouterIdSelection(['rtr_1'], 'rtr_2');
    expect(step1).toEqual(['rtr_1', 'rtr_2']);
    const step2 = toggleRouterIdSelection(step1, 'rtr_1');
    expect(step2).toEqual(['rtr_2']);
  });
});
