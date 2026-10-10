import { describe, expect, it } from 'vitest';
import { budgetToEffort, rewriteEffortAsOutputConfig } from './anthropic.js';

describe('budgetToEffort', () => {
  // the engine's effortPlan table: each level's budget_tokens lands on its own level
  it('maps the engine table exactly', () => {
    expect(budgetToEffort(2048)).toBe('low');
    expect(budgetToEffort(8192)).toBe('medium');
    expect(budgetToEffort(16384)).toBe('high');
    expect(budgetToEffort(32768)).toBe('xhigh');
    expect(budgetToEffort(63999)).toBe('max');
  });
  it('nearest level, ties to the higher one', () => {
    expect(budgetToEffort(1)).toBe('low');
    expect(budgetToEffort(5000)).toBe('low'); // 2952 from low, 3192 from medium
    expect(budgetToEffort(10000)).toBe('medium');
    expect(budgetToEffort(12288)).toBe('high'); // equidistant to medium and high
    expect(budgetToEffort(1_000_000)).toBe('max');
  });
});

describe('rewriteEffortAsOutputConfig', () => {
  const req = (over: Record<string, unknown> = {}) => JSON.stringify({ model: 'grok-4.7', max_tokens: 8192, messages: [{ role: 'user', content: 'hi' }], ...over });

  it('moves a numeric budget into output_config.effort and drops thinking', () => {
    const out = rewriteEffortAsOutputConfig(req({ thinking: { type: 'enabled', budget_tokens: 32768 } }))!;
    const j = JSON.parse(out);
    expect(j.thinking).toBeUndefined();
    expect(j.output_config).toEqual({ effort: 'xhigh' });
    expect(j.model).toBe('grok-4.7');
  });
  it('keeps other output_config fields', () => {
    const out = rewriteEffortAsOutputConfig(req({ thinking: { type: 'enabled', budget_tokens: 8192 }, output_config: { service_tier: 'priority' } }))!;
    expect(JSON.parse(out).output_config).toEqual({ service_tier: 'priority', effort: 'medium' });
  });
  it('leaves a request that already states its effort alone', () => {
    const body = req({ thinking: { type: 'enabled', budget_tokens: 32768 }, output_config: { effort: 'low' } });
    expect(rewriteEffortAsOutputConfig(body)).toBeNull();
  });
  it('leaves requests without a numeric budget alone (adaptive, none, invalid json)', () => {
    expect(rewriteEffortAsOutputConfig(req({ thinking: { type: 'adaptive' } }))).toBeNull();
    expect(rewriteEffortAsOutputConfig(req())).toBeNull();
    expect(rewriteEffortAsOutputConfig('not json')).toBeNull();
  });
});
