# Logic Control Center - 验收清单

## 一、数据库验收 (SQL)

### 1.1 表结构验证
```sql
-- 检查核心表是否存在
SELECT table_name FROM information_schema.tables 
WHERE table_name IN ('logic_versions', 'logic_change_log', 'logic_test_runs', 'user_profiles');

-- 检查列是否完整
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'logic_versions' 
ORDER BY ordinal_position;
```

### 1.2 索引验证
```sql
-- 检查索引
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'logic_versions';

-- 应该有：
-- - idx_logic_versions_lookup
-- - idx_logic_versions_published
-- - idx_unique_published_logic_version (partial unique index)
```

### 1.3 RLS策略验证
```sql
-- 检查RLS策略
SELECT policyname, permissive, roles, cmd, qual 
FROM pg_policies 
WHERE tablename = 'logic_versions';
```

## 二、后端验收 (Edge Functions)

### 2.1 bom-explosion Edge Function
```bash
# 部署并测试
curl -X POST https://<project>.supabase.co/functions/v1/bom-explosion \
  -H "Authorization: Bearer <token>" \
  -d '{
    "plantId": "PLANT_A",
    "timeBuckets": ["2025-W01"],
    "demandSource": "demand_fg",
    "logicVersionId": null  # 测试自动读取 published config
  }'
```

**验收点：**
- [ ] 能读取 logic_versions 中 published 的配置
- [ ] 回退机制：PLANT 无配置时自动使用 GLOBAL
- [ ] 记录 logic_version_id 到 forecast_runs
- [ ] 配置优先级：请求参数 > DB config > 硬编码默认值

### 2.2 logic-test-run Edge Function
```bash
# 测试沙盒运行
curl -X POST https://<project>.supabase.co/functions/v1/logic-test-run \
  -H "Authorization: Bearer <token>" \
  -d '{"testRunId": "<uuid>"}'
```

**验收点：**
- [ ] 能读取 draft version 和 baseline version
- [ ] 采样逻辑正确（Top 80% + Random 20%）
- [ ] Diff report 生成正确
- [ ] 进度更新到 logic_test_runs 表

## 三、前端验收 (/admin/logic)

### 3.1 Logic Tree 导航
**测试步骤：**
1. 访问 `/admin/logic`
2. 检查左側树状结构

**验收点：**
- [ ] BOM Explosion 可展开/收起
- [ ] 显示 🌍 Global 和 🏭 Plant 节点
- [ ] 各节点显示状态标签（published/draft/pending）
- [ ] 点击切换 scope 时右側内容更新

### 3.2 Overview Tab
**测试步骤：**
1. 选择一个已发布的 scope
2. 查看 Published Version 卡片

**验收点：**
- [ ] 显示当前生效版本的基本信息
- [ ] Config Summary 显示 Limits/Rules/Sharding 概览
- [ ] 如有 Draft，显示变更对比（diff）
- [ ] Impact Assessment 显示警告（如 MAX_DEPTH 变更）

### 3.3 Edit Tab
**测试步骤：**
1. 点击 Edit Tab
2. 修改 MAX_BOM_DEPTH 从 50 到 30
3. 等待 2 秒自动保存

**验收点：**
- [ ] 表单加载当前配置（draft 或 published）
- [ ] 修改后自动保存，显示 "Saved at HH:MM:SS"
- [ ] Limits 面板：输入范围校验（1-100）
- [ ] Rules 面板：下拉选项正确
- [ ] Sharding 面板：strategy 切换时条件显示 shard_size
- [ ] 权限控制：Viewer 角色看到只读提示

### 3.4 Sandbox & Diff Tab
**测试步骤：**
1. 确保有 Draft 版本
2. 配置测试范围（Plant + Time Buckets）
3. 点击 "Run Sandbox Test"
4. 等待完成

**验收点：**
- [ ] 能创建 test run，记录到 logic_test_runs
- [ ] 实时进度条更新（10% → 100%）
- [ ] Summary 显示：FG/Demand/Trace/Error counts
- [ ] Diff Report 显示：
  - [ ] Total demand delta %
  - [ ] Top 20 changes 表格
  - [ ] New/Removed components 列表
- [ ] 与 Baseline 对比逻辑正确

### 3.5 Release Tab
**测试步骤：**
1. 创建 Draft → Submit → Approve → Publish
2. 测试 Rollback

**验收点：**
- [ ] Workflow 步骤条正确显示进度
- [ ] Submit 后状态变为 pending_approval
- [ ] Approver 能看到 Approve/Reject 按钮
- [ ] Approve 后触发 regression tests（自动）
- [ ] Publish 后原 published 版本被 archived
- [ ] Rollback 能创建新版本回退到历史配置
- [ ] Audit Trail 记录所有操作日志

## 四、权限验收

### 4.1 角色测试矩阵

| 角色 | 查看 Published | 创建 Draft | Submit | Approve | Publish | Rollback |
|------|---------------|------------|--------|---------|---------|----------|
| viewer | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| logic_editor | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| logic_approver | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| logic_publisher | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 4.2 测试步骤
```sql
-- 修改用户角色测试不同权限
UPDATE user_profiles SET role = 'logic_editor' WHERE user_id = '<test_user_id>';
```

## 五、回归测试验收

### 5.1 基础测试用例
```sql
-- 检查预置测试用例
SELECT name, description FROM logic_regression_tests WHERE is_active = true;

-- 应该有：
-- - Standard Linear BOM Test
-- - Diamond BOM Structure Test  
-- - Deep Nesting BOM Test
-- - Multi-Plant BOM Test
-- - Scrap/Yield Calculation Test
```

### 5.2 发布门控测试
```sql
-- 检查版本是否能发布
SELECT * FROM can_publish_version('<draft_version_id>');

-- 验收点：
-- - 未跑回归测试 → can_publish = false
-- - 回归测试失败 → can_publish = false + violations
-- - 全部通过 → can_publish = true
```

## 六、Job Control Center 验收 (/admin/jobs)

### 6.1 Job List
**验收点：**
- [ ] 列表显示最近 100 个 jobs
- [ ] 筛选器：Status/Job Type 有效
- [ ] 进度条实时显示
- [ ] 状态标签颜色正确

### 6.2 Job Detail Modal
**验收点：**
- [ ] 显示 Job Key、Metadata
- [ ] 显示关联的 Forecast Run
- [ ] 显示 Error Message（如果有）
- [ ] Cancel 按钮对 running jobs 有效
- [ ] Retry 按钮对 failed jobs 有效

## 七、集成验收

### 7.1 End-to-End 流程
```
1. Editor 创建 Draft (MAX_DEPTH: 50→30)
2. Editor 跑 Sandbox Test → 确认影响范围
3. Editor Submit (填写变更原因)
4. Approver Review → Approve
5. 系统自动跑 Regression Tests
6. Publisher 检查测试通过 → Publish
7. 运行 BOM Explosion Job → 使用新配置
8. IT 在 Job Control Center 监控
```

### 7.2 配置生效验证
```sql
-- 确认 job 使用了正确的配置
SELECT 
  b.id, 
  b.logic_version_id, 
  lv.config_json->'limits'->>'MAX_BOM_DEPTH' as used_max_depth
FROM import_batches b
JOIN logic_versions lv ON b.logic_version_id = lv.id
ORDER BY b.created_at DESC
LIMIT 5;
```

## 八、性能验收

### 8.1 Sandbox 性能
- [ ] 1000 FG 采样测试 < 5 分钟完成
- [ ] Diff 计算 < 10 秒

### 8.2 查询性能
```sql
-- 检查查询计划
EXPLAIN ANALYZE 
SELECT * FROM get_published_logic_version('bom_explosion', 'PLANT', 'PLANT_A');
-- 应该使用 idx_logic_versions_lookup，< 10ms
```

## 九、安全验收

### 9.1 RLS 测试
```sql
-- 以普通用户身份
SET ROLE authenticated;

-- 应该只能看到自己的 draft
SELECT * FROM logic_versions WHERE status = 'draft'; 

-- 应该能看到所有 published
SELECT * FROM logic_versions WHERE status = 'published';
```

### 9.2 防注入测试
- [ ] Edit Tab 表单输入 `"}; DROP TABLE logic_versions; --` 不报错但无害
- [ ] JSON 注入尝试被 sanitize

## 十、部署验收

### 10.1 文件清单确认
```
sql/migrations/
  ✓ logic_control_center_schema.sql
  ✓ logic_regression_suite.sql

supabase/functions/
  ✓ bom-explosion/index.ts (已更新)
  ✓ bom-explosion/logicConfig.ts (新增)
  ✓ logic-test-run/index.ts (新增)

src/views/
  ✓ AdminLogicControlCenter/index.jsx
  ✓ AdminLogicControlCenter/LogicTree.jsx
  ✓ AdminLogicControlCenter/OverviewTab.jsx
  ✓ AdminLogicControlCenter/EditTab.jsx
  ✓ AdminLogicControlCenter/SandboxTab.jsx
  ✓ AdminLogicControlCenter/ReleaseTab.jsx
  ✓ AdminJobControlCenter/index.jsx

src/services/
  ✓ logicVersionService.js
  ✓ regressionTestService.js
```

### 10.2 部署步骤确认
```bash
# 1. 执行 SQL 迁移
supabase db push

# 2. 部署 Edge Functions
supabase functions deploy bom-explosion
supabase functions deploy logic-test-run

# 3. 验证前端路由
# 添加 App.jsx 路由后重新部署前端
```

## 验收通过标准

- [ ] 所有 10 大项中的核心功能测试通过
- [ ] 权限矩阵 100% 符合预期
- [ ] 回归测试自动触发且结果正确
- [ ] End-to-End 完整流程跑一次成功
- [ ] 用户文档已更新（可选）

---

**验收签字**
- IT 负责人：__________ 日期：__________
- 业务负责人：________ 日期：__________
