# Cost Analysis 頁面故障排除指南

## 問題：頁面沒有畫面

### 已修復的問題
✅ **Missing Import**: 添加了 `ChevronRight` 到 import 語句中

### 排查步驟

#### 1. 清除瀏覽器緩存
```bash
# 在瀏覽器中按 Ctrl+Shift+R (Windows/Linux)
# 或 Cmd+Shift+R (Mac)
# 強制重新加載並清除緩存
```

#### 2. 檢查瀏覽器控制台錯誤
1. 打開開發者工具 (F12)
2. 切換到 Console 標籤
3. 查看是否有紅色錯誤訊息
4. 將錯誤訊息複製下來

#### 3. 常見錯誤和解決方案

##### 錯誤 1: "ChevronRight is not defined"
**原因**: 缺少 import
**解決**: 已在 line 7 添加 `ChevronRight` import
**狀態**: ✅ 已修復

##### 錯誤 2: "Cannot read property 'hasPriceData' of null"
**原因**: dataCoverage 初始值為 null
**解決**: 使用條件渲染 `(!dataCoverage || !dataCoverage.hasPriceData)`
**狀態**: ✅ 已正確處理

##### 錯誤 3: "operational_costs table not found"
**原因**: 數據庫表未創建
**解決**: 執行 `database/cost_analysis_schema.sql`
**檢查**: 
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('operational_costs', 'cost_anomalies');
```

##### 錯誤 4: 白屏但無錯誤
**原因**: React 渲染問題
**解決**: 
1. 檢查 React DevTools
2. 確認組件是否掛載
3. 檢查條件渲染邏輯

#### 4. 重新啟動開發服務器
```bash
# 停止當前服務器 (Ctrl+C)
# 清除 node_modules/.vite 緩存
rm -rf node_modules/.vite

# 重新啟動
npm run dev
```

#### 5. 檢查路由配置
確認 `App.jsx` 中的路由配置正確：
```javascript
case 'cost-analysis': 
  return <CostAnalysisView addNotification={addNotification} user={session?.user} />;
```

### 驗證步驟

#### 測試 1: 檢查頁面是否加載
1. 導航到 Cost Analysis
2. 應該看到 header "Cost Analysis"
3. 應該看到兩個標籤: "Material Cost" 和 "Operational Cost"

#### 測試 2: 檢查 Material Cost 標籤
1. 點擊 "Material Cost" 標籤
2. 應該看到以下之一：
   - 如果有數據: KPI 卡片、趨勢圖等
   - 如果無數據: 空狀態卡片 "No Material Cost Data Yet"

#### 測試 3: 檢查 Operational Cost 標籤
1. 點擊 "Operational Cost" 標籤
2. 應該看到以下之一：
   - 如果有數據: KPI 卡片、趨勢圖等
   - 如果無數據: 空狀態卡片 "No Operational Cost Data Yet"

#### 測試 4: 檢查導航按鈕
1. 在空狀態下
2. 應該看到 "Go to Data Upload" 按鈕
3. 點擊按鈕應該導航到 External Systems 頁面

### 當前文件狀態

#### src/views/CostAnalysisView.jsx
- **總行數**: 1081 行
- **Import 語句**: ✅ 完整，包含 ChevronRight
- **State 管理**: ✅ 正確
- **函數定義**: ✅ 完整
- **Return 語句**: ✅ 正確閉合
- **Linter 狀態**: ✅ 無錯誤

#### src/services/materialCostService.js
- **總行數**: ~520 行
- **函數數量**: 8 個
- **Export 語句**: ✅ 正確
- **Linter 狀態**: ✅ 無錯誤

### 快速診斷命令

```bash
# 檢查文件是否存在
ls -la src/views/CostAnalysisView.jsx
ls -la src/services/materialCostService.js

# 檢查 import 是否正確
grep "ChevronRight" src/views/CostAnalysisView.jsx

# 檢查 export 是否正確
grep "export default" src/views/CostAnalysisView.jsx

# 運行 linter
npm run lint src/views/CostAnalysisView.jsx
```

### 如果問題持續存在

1. **提供瀏覽器控制台的完整錯誤訊息**
2. **提供瀏覽器和版本** (Chrome, Firefox, Safari, etc.)
3. **提供 React DevTools 截圖**
4. **檢查 Network 標籤** - 確認所有文件都成功加載

### 臨時回滾方案

如果需要緊急回滾到之前的版本：

```bash
# 查看 git 歷史
git log --oneline

# 回滾到特定提交
git checkout <commit-hash> -- src/views/CostAnalysisView.jsx

# 或者完全回滾
git reset --hard HEAD~1
```

### 聯繫支持

如果以上步驟都無法解決問題，請提供：
1. 瀏覽器控制台完整錯誤
2. React DevTools 組件樹截圖
3. Network 標籤截圖
4. 操作系統和瀏覽器版本

---

**最後更新**: 2024年12月7日
**修復狀態**: ✅ ChevronRight import 已添加
**預期結果**: 頁面應該正常顯示




