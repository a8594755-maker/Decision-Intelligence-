// ============================================
// Regression Test Service
// Phase 4: Frontend service for regression testing
// ============================================

import { supabase } from './supabaseClient';

/**
 * Fetch regression test results for a logic version
 */
export async function fetchRegressionResults(logicVersionId) {
  const { data, error } = await supabase
    .from('logic_regression_results')
    .select(`
      *,
      regression_test:regression_test_id (
        id,
        name,
        description,
        thresholds
      )
    `)
    .eq('logic_version_id', logicVersionId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching regression results:', error);
    throw error;
  }

  return data || [];
}

/**
 * Run regression tests for a logic version
 */
export async function runRegressionTests(logicVersionId) {
  const { data, error } = await supabase.rpc('run_regression_tests', {
    p_logic_version_id: logicVersionId,
  });

  if (error) {
    console.error('Error running regression tests:', error);
    throw error;
  }

  return data;
}

/**
 * Check if version can be published (gate check)
 */
export async function checkPublishGate(logicVersionId, thresholdOverrides = {}) {
  const { data, error } = await supabase.rpc('can_publish_version', {
    p_logic_version_id: logicVersionId,
    p_threshold_overrides: thresholdOverrides,
  });

  if (error) {
    console.error('Error checking publish gate:', error);
    throw error;
  }

  return data;
}

/**
 * Fetch all regression test cases for a logic type
 */
export async function fetchRegressionTests(logicId) {
  const { data, error } = await supabase
    .from('logic_regression_tests')
    .select('*')
    .eq('logic_id', logicId)
    .eq('is_active', true)
    .order('name');

  if (error) {
    console.error('Error fetching regression tests:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get status color for regression test result
 */
export function getRegressionStatusColor(status) {
  const colors = {
    pending: 'bg-gray-100 text-gray-800',
    running: 'bg-blue-100 text-blue-800',
    passed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    error: 'bg-orange-100 text-orange-800',
  };
  return colors[status] || 'bg-gray-100 text-gray-800';
}

/**
 * Calculate overall regression summary
 */
export function calculateRegressionSummary(results) {
  if (!results || results.length === 0) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      overallPassed: false,
    };
  }

  const total = results.length;
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => ['failed', 'error'].includes(r.status)).length;
  const pending = results.filter(r => ['pending', 'running'].includes(r.status)).length;

  return {
    total,
    passed,
    failed,
    pending,
    overallPassed: failed === 0 && pending === 0,
  };
}
