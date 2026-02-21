# 文件歸檔區

> 此目錄包含開發歷程、已解決問題的排查記錄、過時的實作細節等歷史文件

## 📋 歸檔原則

此目錄的文件具有以下特性:

- ✅ **歷史價值**: 保留作為開發歷程的記錄
- ✅ **參考意義**: 可供未來遇到類似問題時參考
- ❌ **不再維護**: 不再隨程式碼更新而同步更新
- ❌ **非當前文件**: 非系統當前使用的技術文件

## 📂 文件分類

### 開發歷程記錄

記錄功能開發過程的文件:

- `IMPLEMENTATION_PLAN.md` - 原始實作計劃
- `REFACTORING_PROGRESS.md` - 重構進度記錄
- `NEXT_STEPS.md` - 階段性的下一步規劃
- `INTEGRATION_COMPLETE.md` - 整合完成報告
- `*_SUMMARY.md` - 各階段總結文件

### 問題排查與修復記錄

已解決問題的診斷和修復過程:

- `BOM_EXPLOSION_LOGIC_ISSUES.md` - BOM 邏輯問題診斷
- `BOM_EXPLOSION_FIX_COMPLETE.md` - BOM 修復完成報告
- `PRICE_HISTORY_UPLOAD_DIAGNOSIS.md` - 價格歷史上傳問題診斷
- `COST_ANALYSIS_NO_DATA_DIAGNOSIS.md` - 成本分析無資料問題
- `FIX_DUPLICATE_SUPPLIERS_IN_DB.md` - 重複供應商修復
- `*_FIX_*.md` - 其他修復記錄

### 功能實作細節

特定功能的實作過程記錄:

- `BOM_EXPLOSION_IMPLEMENTATION.md` - BOM 展開實作
- `BOM_EXPLOSION_UI_IMPLEMENTATION.md` - BOM UI 實作
- `MATERIAL_COST_IMPLEMENTATION.md` - 物料成本實作
- `SUPPLIER_VALIDATION_IMPLEMENTATION.md` - 供應商驗證實作
- `*_IMPLEMENTATION.md` - 其他實作文件

### 部署與配置記錄

部署相關的歷史記錄:

- `DEPLOYMENT_GUIDE_MATERIAL_COST.md` - 物料成本部署指南
- `IMPORT_HISTORY_DEPLOYMENT.md` - 匯入歷史部署
- `SECURITY_DEPLOYMENT.md` - 安全性部署
- `*_DEPLOYMENT.md` - 其他部署記錄

### UI/UX 迭代記錄

界面改進和重構記錄:

- `FORECASTS_VIEW_REFACTOR_SUMMARY.md` - Forecasts 重構總結
- `COST_ANALYSIS_UI_CLARITY_UPDATE.md` - 成本分析 UI 更新
- `BOM_DATA_DASHBOARD.md` - BOM 資料儀表板

### Prompt Engineering 歷史

AI Prompt 調整歷史:

- `AI_PROMPT_FIX_FINAL.md` - Prompt 最終修正
- `AI_PROMPT_ULTRA_MINIMAL.md` - 極簡 Prompt
- `AI_PROMPT_CUSTOMIZATION.md` - Prompt 客製化
- `AI-CHAT-SETUP.md` - AI 對話設定

### 測試與驗證記錄

測試相關的歷史文件:

- `FORECASTS_VIEW_TESTING_GUIDE.md` - Forecasts 測試指南
- `MATERIAL_COST_TESTING_GUIDE.md` - 物料成本測試
- `BOM_EXPLOSION_PAYLOAD_EXAMPLES.md` - BOM Payload 範例

### 功能改進記錄

功能迭代和改進記錄:

- `MATERIAL_COST_V1_IMPROVEMENTS.md` - 物料成本 V1 改進
- `CHANGELOG_MATERIAL_COST.md` - 物料成本變更記錄
- `MULTI_SHEET_SUPPORT.md` - 多工作表支援
- `SMART_MERGE_FEATURE.md` - 智能合併功能
- `DUPLICATE_CHECK_FEATURE.md` - 重複檢查功能
- `FRONTEND_DEDUPLICATION.md` - 前端去重

### 排查指南

問題排查相關文件:

- `SUPPLIER_AI_DEBUG_GUIDE.md` - 供應商 AI 除錯
- `AI_MAPPING_TROUBLESHOOTING.md` - AI 映射排查
- `COST_ANALYSIS_TROUBLESHOOTING.md` - 成本分析排查

---

## 🔍 如何使用歸檔文件

### 查找特定問題的解決方案

如果遇到類似的問題,可以搜尋相關的排查文件:

```bash
# 搜尋特定關鍵字
grep -r "BOM circular reference" docs/archive/

# 列出所有修復文件
ls docs/archive/*FIX*.md

# 列出所有診斷文件
ls docs/archive/*DIAGNOSIS*.md
```

### 了解功能演進歷程

查看特定功能的實作歷程:

```bash
# BOM Explosion 相關
ls docs/archive/BOM_EXPLOSION*.md

# Cost Analysis 相關
ls docs/archive/COST_ANALYSIS*.md

# Material Cost 相關
ls docs/archive/MATERIAL_COST*.md
```

### 參考過去的設計決策

實作規劃和架構設計文件:

- `IMPLEMENTATION_PLAN.md` - 原始實作計劃
- `SUPPLIER_KPI_IMPLEMENTATION_PLAN.md` - 供應商 KPI 計劃
- `ARCHITECTURE_DESIGN.md` (在根目錄) - 系統架構 (持續維護)

---

## ⚠️ 重要提醒

1. **不以歸檔文件為準**: 
   - 歸檔文件可能與當前程式碼不一致
   - 請以最新的程式碼和活文件為準

2. **參考價值**:
   - 可以參考解決問題的思路和方法
   - 了解功能演進的脈絡
   - 避免重複踩坑

3. **不建議直接套用**:
   - 程式碼可能已經重構
   - API 可能已經變更
   - 資料結構可能不同

---

## 📚 當前活文件位置

如果需要當前有效的技術文件,請查看:

- **根目錄**: `README.md`, `DATABASE_SCHEMA_GUIDE.md`, `ARCHITECTURE_DESIGN.md`
- **docs/**: 核心技術文件 (`BOM_EXPLOSION.md`, `SETUP.md`, `GLOSSARY.md`)
- **docs/guides/**: 使用者指南和操作手冊
- **src/**: 程式碼本身是最準確的文件

---

**歸檔日期**: 2026-02-04  
**維護者**: Decision-Intelligence Team
