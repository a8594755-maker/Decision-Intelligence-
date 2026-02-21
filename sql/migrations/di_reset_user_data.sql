-- Decision-Intelligence reset helper
-- Clears DI profiles/runs/artifacts for the authenticated user only.

CREATE OR REPLACE FUNCTION public.di_reset_user_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_profile_file_ids TEXT[] := ARRAY[]::TEXT[];
  v_deleted_artifacts INTEGER := 0;
  v_deleted_steps INTEGER := 0;
  v_deleted_runs INTEGER := 0;
  v_deleted_profiles INTEGER := 0;
  v_deleted_contract_templates INTEGER := 0;
  v_deleted_run_settings_templates INTEGER := 0;
  v_deleted_similarity_index INTEGER := 0;
  v_deleted_user_files INTEGER := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required for di_reset_user_data()';
  END IF;

  IF to_regclass('public.di_dataset_profiles') IS NOT NULL THEN
    SELECT COALESCE(array_agg(DISTINCT user_file_id::TEXT), ARRAY[]::TEXT[])
      INTO v_profile_file_ids
    FROM public.di_dataset_profiles
    WHERE user_id = v_user_id
      AND user_file_id IS NOT NULL;
  END IF;

  IF to_regclass('public.di_run_artifacts') IS NOT NULL
     AND to_regclass('public.di_runs') IS NOT NULL THEN
    DELETE FROM public.di_run_artifacts a
    USING public.di_runs r
    WHERE a.run_id = r.id
      AND r.user_id = v_user_id;
    GET DIAGNOSTICS v_deleted_artifacts = ROW_COUNT;
  END IF;

  IF to_regclass('public.di_run_steps') IS NOT NULL
     AND to_regclass('public.di_runs') IS NOT NULL THEN
    DELETE FROM public.di_run_steps s
    USING public.di_runs r
    WHERE s.run_id = r.id
      AND r.user_id = v_user_id;
    GET DIAGNOSTICS v_deleted_steps = ROW_COUNT;
  END IF;

  IF to_regclass('public.di_runs') IS NOT NULL THEN
    DELETE FROM public.di_runs
    WHERE user_id = v_user_id;
    GET DIAGNOSTICS v_deleted_runs = ROW_COUNT;
  END IF;

  IF to_regclass('public.di_dataset_profiles') IS NOT NULL THEN
    DELETE FROM public.di_dataset_profiles
    WHERE user_id = v_user_id;
    GET DIAGNOSTICS v_deleted_profiles = ROW_COUNT;
  END IF;

  IF to_regclass('public.di_contract_templates') IS NOT NULL THEN
    DELETE FROM public.di_contract_templates
    WHERE user_id = v_user_id;
    GET DIAGNOSTICS v_deleted_contract_templates = ROW_COUNT;
  END IF;

  IF to_regclass('public.di_run_settings_templates') IS NOT NULL THEN
    DELETE FROM public.di_run_settings_templates
    WHERE user_id = v_user_id;
    GET DIAGNOSTICS v_deleted_run_settings_templates = ROW_COUNT;
  END IF;

  IF to_regclass('public.di_dataset_similarity_index') IS NOT NULL THEN
    DELETE FROM public.di_dataset_similarity_index
    WHERE user_id = v_user_id;
    GET DIAGNOSTICS v_deleted_similarity_index = ROW_COUNT;
  END IF;

  IF to_regclass('public.user_files') IS NOT NULL AND cardinality(v_profile_file_ids) > 0 THEN
    DELETE FROM public.user_files
    WHERE user_id = v_user_id
      AND id::TEXT = ANY(v_profile_file_ids);
    GET DIAGNOSTICS v_deleted_user_files = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'deleted_artifacts', v_deleted_artifacts,
    'deleted_steps', v_deleted_steps,
    'deleted_runs', v_deleted_runs,
    'deleted_profiles', v_deleted_profiles,
    'deleted_contract_templates', v_deleted_contract_templates,
    'deleted_run_settings_templates', v_deleted_run_settings_templates,
    'deleted_similarity_index', v_deleted_similarity_index,
    'deleted_user_files', v_deleted_user_files,
    'total_deleted',
      v_deleted_artifacts
      + v_deleted_steps
      + v_deleted_runs
      + v_deleted_profiles
      + v_deleted_contract_templates
      + v_deleted_run_settings_templates
      + v_deleted_similarity_index
      + v_deleted_user_files
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.di_reset_user_data() TO authenticated;

-- Ensure PostgREST picks up new RPC immediately
NOTIFY pgrst, 'reload schema';
