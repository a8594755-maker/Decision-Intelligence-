import { describe, expect, it } from 'vitest';
import { classifyQueryIntent } from './queryIntentClassifier.js';

describe('queryIntentClassifier', () => {
  describe('meta tier', () => {
    it('classifies English capability questions as meta', () => {
      expect(classifyQueryIntent('What can you do?').tier).toBe('meta');
      expect(classifyQueryIntent('How do I use this?').tier).toBe('meta');
      expect(classifyQueryIntent('What tools do you have?').tier).toBe('meta');
      expect(classifyQueryIntent('Help me understand this system').tier).toBe('meta');
    });

    it('classifies Chinese capability questions as meta', () => {
      expect(classifyQueryIntent('你能做什麼？').tier).toBe('meta');
      expect(classifyQueryIntent('你有什麼功能？').tier).toBe('meta');
      expect(classifyQueryIntent('怎麼用？').tier).toBe('meta');
    });

    it('classifies greetings as meta', () => {
      expect(classifyQueryIntent('Hello').tier).toBe('meta');
      expect(classifyQueryIntent('Hi').tier).toBe('meta');
      expect(classifyQueryIntent('你好').tier).toBe('meta');
      expect(classifyQueryIntent('Thanks').tier).toBe('meta');
      expect(classifyQueryIntent('ok').tier).toBe('meta');
    });

    it('classifies empty message as meta', () => {
      expect(classifyQueryIntent('').tier).toBe('meta');
      expect(classifyQueryIntent(null).tier).toBe('meta');
    });

    it('does NOT classify analytical capability questions as meta', () => {
      expect(classifyQueryIntent('Can you analyze revenue data for me?').tier).not.toBe('meta');
      expect(classifyQueryIntent('What can you tell me about order trends?').tier).not.toBe('meta');
    });
  });

  describe('complex tier', () => {
    it('classifies comparison requests as complex', () => {
      expect(classifyQueryIntent('Compare high vs low rated categories on revenue').tier).toBe('complex');
      expect(classifyQueryIntent('比較各品類的營收和退貨率').tier).toBe('complex');
    });

    it('classifies recommendation requests as complex', () => {
      expect(classifyQueryIntent('Recommend the best strategy for inventory optimization').tier).toBe('complex');
      expect(classifyQueryIntent('給我具體建議和風險分析').tier).toBe('complex');
    });

    it('classifies diagnostic and root cause requests as complex', () => {
      expect(classifyQueryIntent('Diagnose why delivery times are increasing').tier).toBe('complex');
      expect(classifyQueryIntent('Root cause analysis for the revenue drop').tier).toBe('complex');
    });

    it('classifies what-if scenarios as complex', () => {
      expect(classifyQueryIntent('What if demand grows 20% next year?').tier).toBe('complex');
    });

    it('classifies long multi-dimension requests as complex', () => {
      const longMsg = 'I need you to analyze seller revenue distribution broken down by category and region, ' +
        'including quantile analysis, Gini coefficient calculation, and also provide recommendations for improving ' +
        'seller performance across different segments with detailed statistical backing.';
      expect(classifyQueryIntent(longMsg).tier).toBe('complex');
    });
  });

  describe('simple tier', () => {
    it('classifies single-dimension lookups as simple', () => {
      expect(classifyQueryIntent('What is the total revenue?').tier).toBe('simple');
      expect(classifyQueryIntent('Show me a revenue chart').tier).toBe('simple');
      expect(classifyQueryIntent('總營收是多少？').tier).toBe('simple');
    });

    it('classifies follow-ups as simple when history exists', () => {
      const history = [{ role: 'user', content: 'Show revenue trends' }];
      const result = classifyQueryIntent('Show the same but for orders', history);
      expect(result.tier).toBe('simple');
      expect(result.reason).toBe('follow_up');
    });

    it('classifies follow-ups without history as simple (default)', () => {
      const result = classifyQueryIntent('Show the same chart');
      expect(result.tier).toBe('simple');
      expect(result.reason).toBe('default_single_dimension');
    });
  });
});
