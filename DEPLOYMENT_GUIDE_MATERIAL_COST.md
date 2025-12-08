# Material Cost Analysis - Deployment Guide

## 快速部署清單

### ✅ 前置檢查 (Pre-Deployment)

#### 1. 數據庫檢查
```sql
-- 檢查必要的表是否存在
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('materials', 'price_history', 'suppliers');

-- 預期結果: 應返回 3 行
```

#### 2. 表結構驗證
```sql
-- 檢查 price_history 表的欄位
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'price_history';

-- 必需欄位:
-- - user_id (uuid)
-- - material_id (uuid)
-- - supplier_id (uuid)
-- - order_date (date)
-- - unit_price (numeric)
-- - currency (text)
```

#### 3. RLS (Row Level Security) 檢查
```sql
-- 檢查 RLS 是否已啟用
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE tablename IN ('materials', 'price_history', 'suppliers');

-- 預期: rowsecurity = true
```

#### 4. 索引檢查
```sql
-- 檢查 price_history 表的索引
SELECT indexname 
FROM pg_indexes 
WHERE tablename = 'price_history';

-- 建議索引:
-- - idx_price_history_user_id
-- - idx_price_history_material_id
-- - idx_price_history_order_date
```

---

### 🚀 部署步驟

#### Step 1: 代碼部署
```bash
# 1. 確認當前分支
git branch

# 2. 拉取最新代碼
git pull origin master

# 3. 檢查新增的文件
ls -la src/services/materialCostService.js
ls -la src/views/CostAnalysisView.jsx

# 4. 安裝依賴（如有需要）
npm install

# 5. 運行 linter 檢查
npm run lint

# 6. 構建生產版本
npm run build
```

#### Step 2: 環境變量檢查
```bash
# 確認 .env 文件包含必要的配置
cat .env

# 必需變量:
# - VITE_SUPABASE_URL
# - VITE_SUPABASE_ANON_KEY
# - (可選) VITE_GEMINI_API_KEY
```

#### Step 3: 部署到 Staging
```bash
# 使用您的部署工具（例如 Vercel, Netlify, etc.）
# 範例 (Vercel):
vercel --prod

# 或
npm run deploy:staging
```

#### Step 4: Staging 驗證
1. 訪問 staging URL
2. 登入測試帳號
3. 導航到 Cost Analysis > Material Cost
4. 執行以下測試：
   - [ ] 空狀態正確顯示
   - [ ] 上傳測試數據
   - [ ] KPI 卡片顯示正確
   - [ ] 材料下拉選單可用
   - [ ] 價格趨勢圖正確渲染
   - [ ] Top Movers 表格顯示
   - [ ] 供應商比較功能正常
   - [ ] AI 建議可生成
   - [ ] 視圖切換正常
   - [ ] 無控制台錯誤

#### Step 5: 部署到 Production
```bash
# 確認 staging 測試通過後
vercel --prod

# 或
npm run deploy:production
```

#### Step 6: Production 驗證
1. 訪問生產環境 URL
2. 使用真實用戶帳號測試
3. 檢查性能指標
4. 監控錯誤日誌

---

### 📊 部署後監控

#### 1. 性能監控
```javascript
// 在瀏覽器控制台執行
console.time('Material Cost Load');
// 切換到 Material Cost 視圖
console.timeEnd('Material Cost Load');

// 預期: < 3 秒
```

#### 2. 錯誤監控
- 檢查瀏覽器控制台
- 檢查 Supabase 日誌
- 檢查應用程式日誌

#### 3. 用戶回饋收集
- 設置用戶回饋表單
- 監控支持請求
- 收集使用數據

---

### 🔧 故障排除

#### 問題 1: 頁面白屏
**症狀**: 切換到 Material Cost 視圖時頁面白屏

**解決方案**:
1. 檢查瀏覽器控制台錯誤
2. 確認 `materialCostService.js` 已正確部署
3. 檢查 import 語句是否正確
4. 清除瀏覽器緩存並重新加載

**檢查命令**:
```bash
# 確認文件存在
ls -la dist/assets/*.js | grep material

# 檢查構建日誌
cat build.log | grep error
```

---

#### 問題 2: KPI 顯示 0 或 NaN
**症狀**: KPI 卡片顯示 0 或 NaN

**解決方案**:
1. 檢查數據庫中是否有 price_history 記錄
2. 確認 order_date 在選定期間內
3. 驗證 material_id 和 supplier_id 外鍵正確

**檢查 SQL**:
```sql
-- 檢查當前用戶的 price_history 記錄
SELECT COUNT(*), MIN(order_date), MAX(order_date)
FROM price_history
WHERE user_id = 'your-user-id';

-- 檢查外鍵關聯
SELECT ph.*, m.material_code, s.supplier_name
FROM price_history ph
LEFT JOIN materials m ON ph.material_id = m.id
LEFT JOIN suppliers s ON ph.supplier_id = s.id
WHERE ph.user_id = 'your-user-id'
LIMIT 5;
```

---

#### 問題 3: AI 建議無法生成
**症狀**: 點擊 "Generate" 按鈕後顯示錯誤

**解決方案**:
1. 檢查 Gemini API Key 是否設置
2. 確認 API quota 未超限
3. 檢查網路連接

**檢查步驟**:
```javascript
// 在瀏覽器控制台執行
localStorage.getItem('gemini_api_key')

// 如果返回 null，設置 API Key:
localStorage.setItem('gemini_api_key', 'your-api-key-here')
```

---

#### 問題 4: 圖表不顯示
**症狀**: 價格趨勢圖不渲染

**解決方案**:
1. 確認 SimpleLineChart 組件已正確導入
2. 檢查 materialTrend.prices 數組是否有效
3. 驗證數據格式正確

**調試代碼**:
```javascript
// 在 CostAnalysisView.jsx 中添加調試日誌
console.log('Material Trend:', materialTrend);
console.log('Prices:', materialTrend?.prices);
```

---

#### 問題 5: 供應商比較不顯示
**症狀**: 選擇材料後供應商比較區塊為空

**解決方案**:
1. 確認該材料有多個供應商的價格記錄
2. 檢查 supplier_id 外鍵是否正確
3. 驗證 supplierComparison 狀態已正確設置

**檢查 SQL**:
```sql
-- 檢查特定材料的供應商數量
SELECT m.material_code, COUNT(DISTINCT ph.supplier_id) as supplier_count
FROM price_history ph
JOIN materials m ON ph.material_id = m.id
WHERE ph.user_id = 'your-user-id'
  AND m.material_code = 'MAT001'
GROUP BY m.material_code;
```

---

### 📝 回滾計劃

如果部署後發現嚴重問題，可以快速回滾：

#### 選項 1: 隱藏新功能
```jsx
// 在 CostAnalysisView.jsx 中臨時隱藏 Material Cost 標籤
{false && ( // 添加 false &&
  <button onClick={() => setViewMode('material')}>
    ...
  </button>
)}
```

#### 選項 2: Git 回滾
```bash
# 查看提交歷史
git log --oneline

# 回滾到特定提交
git revert <commit-hash>

# 推送回滾
git push origin master

# 重新部署
npm run build
npm run deploy
```

#### 選項 3: 功能開關
```javascript
// 添加環境變量控制
const ENABLE_MATERIAL_COST = import.meta.env.VITE_ENABLE_MATERIAL_COST === 'true';

// 在 CostAnalysisView 中使用
{ENABLE_MATERIAL_COST && (
  // Material Cost UI
)}
```

---

### ✅ 部署成功確認

部署完成後，確認以下所有項目：

#### 功能驗證
- [ ] Material Cost 標籤可見
- [ ] 點擊標籤可切換視圖
- [ ] KPI 卡片顯示正確數據
- [ ] 材料下拉選單可用
- [ ] 價格趨勢圖正確顯示
- [ ] Top Movers 表格正常
- [ ] 過濾器功能正常
- [ ] 供應商比較正常
- [ ] AI 建議可生成
- [ ] 數據覆蓋面板顯示
- [ ] 空狀態正確處理

#### 性能驗證
- [ ] 初始加載 < 3 秒
- [ ] 期間切換 < 2 秒
- [ ] 無明顯卡頓
- [ ] 圖表渲染流暢

#### 兼容性驗證
- [ ] Chrome 測試通過
- [ ] Firefox 測試通過
- [ ] Safari 測試通過
- [ ] Edge 測試通過
- [ ] 桌面視圖正常
- [ ] 平板視圖正常
- [ ] 手機視圖正常

#### 安全驗證
- [ ] 只能查看自己的數據
- [ ] RLS 政策生效
- [ ] 無未授權訪問
- [ ] API Key 安全存儲

---

### 📞 支持與聯繫

**部署問題**:
- 檢查部署日誌
- 聯繫 DevOps 團隊

**功能問題**:
- 查看 `MATERIAL_COST_TESTING_GUIDE.md`
- 聯繫開發團隊

**用戶支持**:
- 提供 `MATERIAL_COST_QUICK_START.md` 給用戶
- 設置內部支持流程

---

### 🎉 部署完成

恭喜！Material Cost Analysis 功能已成功部署。

**下一步**:
1. 通知用戶新功能上線
2. 收集用戶反饋
3. 監控使用情況
4. 規劃下一階段改進

---

**部署日期**: ___________  
**部署人員**: ___________  
**驗證人員**: ___________  
**狀態**: ⏳ 待部署 / ✅ 已部署




