import { describe, expect, it } from 'vitest';
import { evaluateRouterHealth } from '../routerHealth.ts';

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
