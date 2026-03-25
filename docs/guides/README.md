---
owner: di-core-team
status: active
last_reviewed: 2026-03-24
---

# Decision-Intelligence 使用指南

> 此目錄包含所有使用者指南、操作手冊和功能說明文件

## 📋 指南目錄

### 資料上傳指南

- **[DATA_UPLOAD_COMPLETE_GUIDE.md](./DATA_UPLOAD_COMPLETE_GUIDE.md)** ⭐
  - **完整上傳流程說明** (5 個步驟)
  - 適合新手第一次上傳資料
  - 包含常見錯誤和解決方法

- **[DATA_VALIDATION_GUIDE.md](./DATA_VALIDATION_GUIDE.md)**
  - 資料驗證規則詳解
  - 各種上傳類型的欄位要求
  - 驗證失敗的原因和解決方法

- **[UPLOAD_WORKFLOW_GUIDE.md](./UPLOAD_WORKFLOW_GUIDE.md)**
  - 上傳工作流程圖
  - Step-by-step 操作說明
  - 最佳實踐建議

### AI 功能指南

- **[AI_MAPPING_GUIDE.md](./AI_MAPPING_GUIDE.md)** ⭐
  - AI 自動欄位映射功能說明
  - 如何使用 AI 快速完成映射
  - 提高 AI 準確度的技巧
  - 故障排除

### 欄位映射指南

- **[MAPPING_TEMPLATE_GUIDE.md](./MAPPING_TEMPLATE_GUIDE.md)**
  - 映射模板功能說明
  - 如何保存和重用映射
  - 模板管理技巧

### 供應商管理指南

- **[SUPPLIER_VALIDATION_GUIDE.md](./SUPPLIER_VALIDATION_GUIDE.md)** ⭐
  - 供應商主檔驗證規則詳解
  - 必填欄位說明
  - 異常文字檢測
  - 電話號碼驗證
  - 多餘欄位處理

### 匯入歷史指南

- **[IMPORT_HISTORY_GUIDE.md](./IMPORT_HISTORY_GUIDE.md)** ⭐
  - 匯入歷史功能說明
  - 如何查看上傳記錄
  - 如何撤銷 (Undo) 批次
  - 批量操作指南

### 成本分析指南

- **[COST_ANALYSIS_GUIDE.md](./COST_ANALYSIS_GUIDE.md)** ⭐
  - 成本分析功能完整說明
  - 如何記錄每日成本
  - 查看成本趨勢
  - 成本異常檢測
  - AI 優化建議

### 物料成本快速入門

- **[MATERIAL_COST_QUICK_START.md](./MATERIAL_COST_QUICK_START.md)** ⭐
  - 物料成本分析快速開始
  - 5 分鐘快速上手
  - 核心功能介紹
  - 實際應用範例

---

## 🚀 快速開始路徑

### 新手路徑

1. **環境設定**: 閱讀 [../SETUP.md](../SETUP.md)
2. **第一次上傳**: 閱讀 [DATA_UPLOAD_COMPLETE_GUIDE.md](./DATA_UPLOAD_COMPLETE_GUIDE.md)
3. **使用 AI 映射**: 閱讀 [AI_MAPPING_GUIDE.md](./AI_MAPPING_GUIDE.md)
4. **查看術語表**: 閱讀 [../GLOSSARY.md](../GLOSSARY.md)

### 功能專家路徑

依照想使用的功能選擇:

- **供應商管理** → [SUPPLIER_VALIDATION_GUIDE.md](./SUPPLIER_VALIDATION_GUIDE.md)
- **成本分析** → [COST_ANALYSIS_GUIDE.md](./COST_ANALYSIS_GUIDE.md)
- **物料成本** → [MATERIAL_COST_QUICK_START.md](./MATERIAL_COST_QUICK_START.md)
- **匯入歷史** → [IMPORT_HISTORY_GUIDE.md](./IMPORT_HISTORY_GUIDE.md)
- **BOM Explosion** → [../BOM_EXPLOSION.md](../BOM_EXPLOSION.md)

---

## 📚 文件使用建議

### 按功能查找

| 功能 | 推薦閱讀 | 閱讀時間 |
|-----|---------|---------|
| 資料上傳 | DATA_UPLOAD_COMPLETE_GUIDE.md | 10 分鐘 |
| AI 映射 | AI_MAPPING_GUIDE.md | 15 分鐘 |
| 供應商管理 | SUPPLIER_VALIDATION_GUIDE.md | 20 分鐘 |
| 成本分析 | COST_ANALYSIS_GUIDE.md | 15 分鐘 |
| 匯入歷史 | IMPORT_HISTORY_GUIDE.md | 10 分鐘 |
| 欄位映射 | MAPPING_TEMPLATE_GUIDE.md | 10 分鐘 |

### 按問題類型查找

| 問題類型 | 查看文件 |
|---------|---------|
| 上傳失敗 | DATA_UPLOAD_COMPLETE_GUIDE.md → 常見錯誤 |
| 驗證錯誤 | DATA_VALIDATION_GUIDE.md |
| AI 映射不準 | AI_MAPPING_GUIDE.md → 故障排除 |
| 供應商資料異常 | SUPPLIER_VALIDATION_GUIDE.md → 實際範例 |
| 找不到上傳記錄 | IMPORT_HISTORY_GUIDE.md → 故障排除 |
| Undo 失敗 | IMPORT_HISTORY_GUIDE.md → 故障排除 |

---

## 🎯 文件特點

### ⭐ 標註說明

- **⭐**: 必讀文件,涵蓋核心功能
- **無標記**: 進階功能或特定場景

### 文件結構

所有指南都遵循統一結構:

1. **概述**: 功能簡介
2. **主要特性**: 核心功能列表
3. **使用流程**: Step-by-step 操作
4. **實際範例**: 真實使用案例
5. **常見問題**: 故障排除
6. **技術細節**: API 和實作 (可選)

### 閱讀建議

- **新手**: 先看「概述」和「使用流程」
- **有經驗**: 直接跳到「實際範例」
- **遇到問題**: 先看「常見問題」
- **開發者**: 深入閱讀「技術細節」

---

## 🔗 相關文件

### 核心技術文件

- [../BOM_EXPLOSION.md](../BOM_EXPLOSION.md) - BOM 展開功能文件
- [../SETUP.md](../SETUP.md) - 環境設定指南
- [../GLOSSARY.md](../GLOSSARY.md) - 術語表

### 根目錄文件

- [../../README.md](../../README.md) - 專案總覽
- [../../DATABASE_SCHEMA_GUIDE.md](../../DATABASE_SCHEMA_GUIDE.md) - 資料庫結構
- [../../ARCHITECTURE_DESIGN.md](../../ARCHITECTURE_DESIGN.md) - 系統架構

### 歷史文件

- [../archive/](../archive/) - 開發歷程和已解決問題記錄

---

## 💡 使用技巧

### 1. 搜尋功能

使用 Ctrl+F (或 Cmd+F) 在文件中搜尋關鍵字。

### 2. 參考範例

每個指南都包含實際範例,可以直接參考和套用。

### 3. 循序漸進

不需要一次讀完所有文件,依需求閱讀即可。

### 4. 實作中學習

邊閱讀邊操作系統,效果最好。

---

## 📝 文件維護

### 更新頻率

- ✅ **活躍維護**: 隨功能更新而同步更新
- ✅ **準確性**: 與最新程式碼保持一致
- ✅ **及時性**: 新功能會儘快補充文件

### 回饋與建議

如果發現文件有誤或需要補充:

1. 在 GitHub 提 Issue
2. 提交 Pull Request
3. 聯繫維護團隊

---

**維護者**: Decision-Intelligence Team  
**最後更新**: 2026-02-04  
**文件數量**: 9 個使用指南
