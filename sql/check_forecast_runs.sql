-- 查看可用的 BOM Explosion runs（用于 Revenue Forecast 输入）
SELECT fr.id, fr.scenario_name, fr.status, fr.job_key, fr.created_at, fr.parameters
FROM forecast_runs fr
WHERE fr.user_id = '291075be-3bee-43ff-a296-17c8eecd26a1'
  AND fr.status = 'completed'
ORDER BY fr.created_at DESC
LIMIT 5;
