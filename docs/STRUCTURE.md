# Decision-Intelligence 文件結構圖

> 最後更新: 2026-02-04

## 📁 完整目錄結構

```
Decision-Intelligence/
│
├── 📄 README.md                          # ⭐ 專案總覽
├── 📄 ARCHITECTURE_DESIGN.md             # 系統架構設計
├── 📄 DATABASE_SCHEMA_GUIDE.md           # 資料庫結構說明
├── 📄 DOCS_REFACTOR_REPORT.md            # 文件重構報告
│
├── 📂 docs/                              # 核心技術文件
│   ├── 📄 BOM_EXPLOSION.md               # ⭐ BOM 展開功能 (主要文件)
│   ├── 📄 BOM_EXPLOSION_SPEC.md          # BOM 技術規格 (詳細參考)
│   ├── 📄 BOM_EXPLOSION_TEST_GUIDE.md    # BOM 測試指南
│   ├── 📄 SETUP.md                       # ⭐ 環境設定指南
│   ├── 📄 GLOSSARY.md                    # ⭐ 術語表
│   ├── 📄 STRUCTURE.md                   # 文件結構圖 (本文件)
│   │
│   ├── 📂 guides/                        # 使用者指南 (9個)
│   │   ├── 📄 README.md                  # 指南索引
│   │   ├── 📄 DATA_UPLOAD_COMPLETE_GUIDE.md      # ⭐ 資料上傳
│   │   ├── 📄 AI_MAPPING_GUIDE.md                # ⭐ AI 映射
│   │   ├── 📄 SUPPLIER_VALIDATION_GUIDE.md       # ⭐ 供應商驗證
│   │   ├── 📄 COST_ANALYSIS_GUIDE.md             # ⭐ 成本分析
│   │   ├── 📄 IMPORT_HISTORY_GUIDE.md            # ⭐ 匯入歷史
│   │   ├── 📄 MATERIAL_COST_QUICK_START.md       # 物料成本入門
│   │   ├── 📄 MAPPING_TEMPLATE_GUIDE.md          # 映射模板
│   │   ├── 📄 DATA_VALIDATION_GUIDE.md           # 資料驗證
│   │   └── 📄 UPLOAD_WORKFLOW_GUIDE.md           # 上傳流程
│   │
│   ├── 📂 archive/                       # 歷史文件 (56個)
│   │   ├── 📄 README.md                  # 歸檔說明
│   │   ├── 📄 NEXT_STEPS.md              # 開發進度
│   │   ├── 📄 IMPLEMENTATION_*.md        # 實作記錄 (4個)
│   │   ├── 📄 BOM_EXPLOSION_*.md         # BOM 開發歷程 (6個)
│   │   ├── 📄 *_FIX_*.md                 # 修復記錄 (5個)
│   │   ├── 📄 *_DEPLOYMENT.md            # 部署記錄 (3個)
│   │   ├── 📄 *_TROUBLESHOOTING.md       # 排查記錄 (3個)
│   │   └── 📄 ... (其他歷史文件)
│   │
│   └── 📂 api/                           # API 文件 (預留)
│
├── 📂 src/                               # 原始碼
│   ├── App.jsx
│   ├── main.jsx
│   ├── 📂 views/                         # 頁面視圖
│   │   ├── SupplierManagementView.jsx
│   │   ├── CostAnalysisView.jsx
│   │   ├── ForecastsView.jsx
│   │   ├── ImportHistoryView.jsx
│   │   └── ...
│   ├── 📂 services/                      # 服務層
│   │   ├── supabaseClient.js
│   │   ├── geminiAPI.js
│   │   ├── bomExplosionService.js
│   │   ├── costAnalysisService.js
│   │   └── ...
│   ├── 📂 utils/                         # 工具函數
│   │   ├── dataValidation.js
│   │   ├── dataProcessing.js
│   │   ├── aiMappingHelper.js
│   │   └── ...
│   └── 📂 components/                    # UI 組件
│       ├── 📂 ui/
│       └── 📂 charts/
│
├── 📂 database/                          # 資料庫腳本
│   ├── supplier_kpi_schema.sql
│   ├── import_batches_schema.sql
│   ├── bom_forecast_schema.sql
│   ├── cost_analysis_schema.sql
│   └── ...
│
├── 📂 templates/                         # 上傳模板
│   ├── bom_edge.xlsx / .csv
│   ├── demand_fg.xlsx / .csv
│   └── ...
│
├── 📂 test_data_examples/                # 測試資料範例
│   └── supplier_master_test_cases.md
│
└── 📂 scripts/                           # 腳本工具
    └── ...
```

---

## 🎯 文件導航路徑

### 新手路徑 (First-Time Users)

```
1. README.md (了解專案)
   ↓
2. docs/SETUP.md (設定環境)
   ↓
3. docs/guides/DATA_UPLOAD_COMPLETE_GUIDE.md (第一次上傳)
   ↓
4. docs/guides/AI_MAPPING_GUIDE.md (使用 AI 功能)
   ↓
5. docs/GLOSSARY.md (查詢術語)
```

### 功能專家路徑

| 功能 | 文件路徑 |
|-----|---------|
| **供應商管理** | docs/guides/SUPPLIER_VALIDATION_GUIDE.md |
| **成本分析** | docs/guides/COST_ANALYSIS_GUIDE.md |
| **BOM 展開** | docs/BOM_EXPLOSION.md |
| **匯入歷史** | docs/guides/IMPORT_HISTORY_GUIDE.md |
| **資料上傳** | docs/guides/DATA_UPLOAD_COMPLETE_GUIDE.md |

### 開發者路徑

```
1. ARCHITECTURE_DESIGN.md (系統架構)
   ↓
2. DATABASE_SCHEMA_GUIDE.md (資料庫結構)
   ↓
3. docs/BOM_EXPLOSION_SPEC.md (技術規格)
   ↓
4. src/ (原始碼)
   ↓
5. docs/archive/ (歷史參考)
```

---

## 📊 文件統計

| 類別 | 數量 | 說明 |
|-----|------|------|
| **根目錄核心** | 3 | README, ARCHITECTURE, DATABASE_SCHEMA |
| **docs/ 技術文件** | 6 | 含本文件 |
| **guides/ 使用指南** | 10 | 含 README |
| **archive/ 歷史文件** | 57 | 含 README |
| **總計** | 76 | 所有 Markdown 文件 |

---

## 📋 文件類型說明

### ⭐ 必讀文件

標記 ⭐ 的文件是核心必讀文件,涵蓋主要功能和使用方法。

### 文件狀態標記

- **🟢 Current**: 當前有效文件,與程式碼同步
- **🟡 Draft**: 草稿或規劃中
- **🔴 Archived**: 已歸檔,不再維護

### 文件分類

| 分類 | 位置 | 用途 |
|-----|------|------|
| **核心技術** | docs/ | 系統架構、功能規格、設定指南 |
| **使用指南** | docs/guides/ | 操作手冊、功能說明、最佳實踐 |
| **API 文件** | docs/api/ | API 參考 (預留) |
| **歷史文件** | docs/archive/ | 開發歷程、問題記錄、參考資料 |

---

## 🔗 快速連結

### 核心文件

- [README.md](../README.md) - 專案總覽
- [SETUP.md](./SETUP.md) - 環境設定
- [GLOSSARY.md](./GLOSSARY.md) - 術語表
- [BOM_EXPLOSION.md](./BOM_EXPLOSION.md) - BOM 功能

### 使用指南

- [資料上傳指南](./guides/DATA_UPLOAD_COMPLETE_GUIDE.md)
- [AI 映射指南](./guides/AI_MAPPING_GUIDE.md)
- [供應商驗證指南](./guides/SUPPLIER_VALIDATION_GUIDE.md)
- [成本分析指南](./guides/COST_ANALYSIS_GUIDE.md)
- [匯入歷史指南](./guides/IMPORT_HISTORY_GUIDE.md)
- [更多指南...](./guides/README.md)

### 技術文件

- [系統架構](../ARCHITECTURE_DESIGN.md)
- [資料庫結構](../DATABASE_SCHEMA_GUIDE.md)
- [BOM 技術規格](./BOM_EXPLOSION_SPEC.md)
- [BOM 測試指南](./BOM_EXPLOSION_TEST_GUIDE.md)

### 歷史文件

- [歸檔區](./archive/README.md)
- [開發歷程](./archive/NEXT_STEPS.md)
- [問題修復記錄](./archive/)

---

## 💡 文件使用技巧

### 1. 快速搜尋

```bash
# 搜尋特定關鍵字
grep -r "BOM Explosion" docs/

# 列出所有指南
ls docs/guides/*.md

# 列出所有歸檔文件
ls docs/archive/*.md
```

### 2. 按問題類型查找

| 問題 | 查看 |
|-----|------|
| 上傳失敗 | docs/guides/DATA_UPLOAD_COMPLETE_GUIDE.md |
| 驗證錯誤 | docs/guides/DATA_VALIDATION_GUIDE.md |
| AI 不準 | docs/guides/AI_MAPPING_GUIDE.md |
| 供應商異常 | docs/guides/SUPPLIER_VALIDATION_GUIDE.md |
| 找不到記錄 | docs/guides/IMPORT_HISTORY_GUIDE.md |
| BOM 計算錯誤 | docs/BOM_EXPLOSION_TEST_GUIDE.md |

### 3. 閱讀順序建議

**初次使用**:
1. README → SETUP → 第一個 Guide
2. 遇到問題時查 Troubleshooting
3. 深入了解時讀技術規格

**功能開發**:
1. ARCHITECTURE → DATABASE_SCHEMA
2. 相關功能的技術文件
3. 參考 archive/ 的歷史記錄

---

## 📝 文件維護

### 更新原則

- **活文件** (docs/ 和 guides/): 隨程式碼更新
- **歷史文件** (archive/): 不再更新,保留記錄
- **核心文件** (根目錄): 重大變更時更新

### 回饋管道

- GitHub Issues
- Pull Requests
- 文件團隊

---

**維護者**: Decision-Intelligence Team  
**文件版本**: 1.0  
**最後更新**: 2026-02-04
