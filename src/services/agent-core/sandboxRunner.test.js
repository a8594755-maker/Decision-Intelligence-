// @product: ai-employee
import { describe, it, expect } from 'vitest';
import { runInSandbox } from './sandboxRunner';

// Tests run in Node (no Worker), so they exercise the _runDirect fallback.

describe('runInSandbox', () => {
  it('executes a simple run() function', async () => {
    const code = `function run(input) { return input.a + input.b; }`;
    const { result, stderr, durationMs } = await runInSandbox(code, { a: 3, b: 7 });
    expect(result).toBe(10);
    expect(stderr).toBe('');
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures console.log output', async () => {
    const code = `
      function run(input) {
        console.log('hello', input.name);
        return { greeted: true };
      }
    `;
    const { result, stdout } = await runInSandbox(code, { name: 'world' });
    expect(result).toEqual({ greeted: true });
    expect(stdout).toContain('hello world');
  });

  it('captures console.error in stderr', async () => {
    const code = `
      function run(input) {
        console.error('warning: low data');
        return 42;
      }
    `;
    const { result, stderr } = await runInSandbox(code, {});
    expect(result).toBe(42);
    expect(stderr).toContain('warning: low data');
  });

  it('handles runtime errors gracefully', async () => {
    const code = `function run(input) { return input.foo.bar.baz; }`;
    const { result, stderr } = await runInSandbox(code, {});
    expect(result).toBeNull();
    expect(stderr).toBeTruthy();
  });

  it('handles syntax errors gracefully', async () => {
    const code = `function run(input) { return @@@ }`;
    const { result, stderr } = await runInSandbox(code, {});
    expect(result).toBeNull();
    expect(stderr).toBeTruthy();
  });

  it('returns undefined result when no run() function defined', async () => {
    const code = `const x = 42;`;
    const { result } = await runInSandbox(code, {});
    expect(result).toBeUndefined();
  });

  it('handles complex return values', async () => {
    const code = `
      function run(input) {
        const items = input.data.map(x => x * 2);
        return {
          result: items,
          metadata: { count: items.length, sum: items.reduce((a,b) => a+b, 0) }
        };
      }
    `;
    const { result } = await runInSandbox(code, { data: [1, 2, 3, 4, 5] });
    expect(result.result).toEqual([2, 4, 6, 8, 10]);
    expect(result.metadata.count).toBe(5);
    expect(result.metadata.sum).toBe(30);
  });

  it('allows Math, Date, JSON usage', async () => {
    const code = `
      function run(input) {
        return {
          sqrt: Math.sqrt(input.n),
          now: typeof Date.now(),
          parsed: JSON.parse('{"ok":true}'),
        };
      }
    `;
    const { result } = await runInSandbox(code, { n: 16 });
    expect(result.sqrt).toBe(4);
    expect(result.now).toBe('number');
    expect(result.parsed.ok).toBe(true);
  });

  it('returns durationMs', async () => {
    const code = `function run() { let s = 0; for (let i = 0; i < 1000; i++) s += i; return s; }`;
    const { result, durationMs } = await runInSandbox(code, {});
    expect(result).toBe(499500);
    expect(typeof durationMs).toBe('number');
  });

  it('handles empty input', async () => {
    const code = `function run() { return 'ok'; }`;
    const { result } = await runInSandbox(code, null);
    expect(result).toBe('ok');
  });

  it('handles array processing', async () => {
    const code = `
      function run(input) {
        const sorted = [...input.items].sort((a, b) => a.value - b.value);
        return { sorted, min: sorted[0].value, max: sorted[sorted.length-1].value };
      }
    `;
    const { result } = await runInSandbox(code, {
      items: [{ value: 30 }, { value: 10 }, { value: 20 }],
    });
    expect(result.min).toBe(10);
    expect(result.max).toBe(30);
    expect(result.sorted[0].value).toBe(10);
  });
});
