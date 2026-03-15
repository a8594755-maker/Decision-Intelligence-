/**
 * reviewRepo.js — Supabase CRUD for ai_employee_reviews.
 *
 * Replaces the review portion of aiEmployeeService.js.
 * No localStorage fallback.
 */

import { supabase } from '../../supabaseClient.js';

/**
 * Create a review record.
 */
export async function createReview(taskId, runId, { decision, comments = null, createdBy = null }) {
  const { data, error } = await supabase
    .from('ai_employee_reviews')
    .insert({
      task_id: taskId,
      run_id: runId,
      reviewer_type: 'human_manager',
      decision,
      comments,
      created_by: createdBy,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(`[ReviewRepo] createReview failed: ${error.message}`);
  return data;
}

/**
 * List reviews for a task, most recent first.
 */
export async function listReviewsForTask(taskId) {
  const { data, error } = await supabase
    .from('ai_employee_reviews')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`[ReviewRepo] listReviewsForTask failed: ${error.message}`);
  return data || [];
}
