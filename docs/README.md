# SmartOps 文件索引

> 📌 **文件系統改版日期：2026-02-05**  
> 🎯 **目標：AI 友善、可維護、易查找**

---

## 📂 目錄結構

```
docs/
├── README.md                   # 本文件（總索引）
├── guides/                     # 當前有效指南（最多12份）
├── archive/                    # 歷史文件存檔
│   ├── summaries/             # 實作總結、完成報告
│   ├── troubleshooting/       # 問題修復、除錯記錄
│   └── [其他歷史文件]
├── BOM_EXPLOSION_SPEC.md      # BOM 展開規格
├── BOM_EXPLOSION_TEST_GUIDE.md
├── GLOSSARY.md                # 術語表
├── SETUP.md                   # 環境設定
└── STRUCTURE.md               # 專案結構
```

---

## 🟢 當前有效指南（Active Guides）

以下是**目前仍在使用**的核心技術文件，按重要性排序：

| # | 文件名稱 | 用途摘要 | 狀態 | 最後審閱 |
|---|---------|---------|------|---------|
| 1 | [ARCHITECTURE_DESIGN.md](guides/ARCHITECTURE_DESIGN.md) | 系統整體架構設計 | 🟢 Active | 2026-02 |
| 2 | [DOMAIN_ARCHITECTURE_COMPLETE.md](guides/DOMAIN_ARCHITECTURE_COMPLETE.md) | Domain Layer 架構完整說明 | 🟢 Active | 2026-02 |
| 3 | [ONE_SHOT_FRAMEWORK_GUIDE.md](guides/ONE_SHOT_FRAMEWORK_GUIDE.md) | One-shot Import 泛用框架 | 🟢 Active | 2026-02 |
| 4 | [DATABASE_SCHEMA_GUIDE.md](guides/DATABASE_SCHEMA_GUIDE.md) | 資料庫結構與 Payload 格式 | 🟢 Active | 2026-02 |
| 5 | [SUPABASE_SERVICES_API_REFERENCE.md](guides/SUPABASE_SERVICES_API_REFERENCE.md) | Supabase 服務層 API 參考 | 🟢 Active | 2026-02 |
| 6 | [VALIDATION_RULES_QUICK_REFERENCE.md](guides/VALIDATION_RULES_QUICK_REFERENCE.md) | 資料驗證規則快速參考 | 🟢 Active | 2026-02 |
| 7 | [UPLOAD_TYPES_REQUIRED_FIELDS.md](guides/UPLOAD_TYPES_REQUIRED_FIELDS.md) | 各上傳類型必要欄位規範 | 🟢 Active | 2026-02 |
| 8 | [NEW_TEMPLATES_GUIDE.md](guides/NEW_TEMPLATES_GUIDE.md) | 模板檔案產生指南 | 🟢 Active | 2026-02 |
| 9 | [DATA_VALIDATION_GUIDE.md](guides/DATA_VALIDATION_GUIDE.md) | 資料驗證流程與規則 | 🟢 Active | 2026-02 |
| 10 | [UPLOAD_WORKFLOW_GUIDE.md](guides/UPLOAD_WORKFLOW_GUIDE.md) | 資料上傳完整工作流程 | 🟢 Active | 2026-02 |
| 11 | [INGEST_RPC_QUICKSTART.md](guides/INGEST_RPC_QUICKSTART.md) | RPC 匯入快速開始 | 🟢 Active | 2026-02 |
| 12 | [STEP1_SCHEMA_DEPLOYMENT_GUIDE.md](guides/STEP1_SCHEMA_DEPLOYMENT_GUIDE.md) | Schema 部署指南 | 🟢 Active | 2026-02 |

---

## 🔴 歷史文件（Archive）

### archive/summaries/（實作總結）

包含各階段的完成報告、實作總結、重構記錄：

- `ONESHOT_*.md` - One-shot 匯入各階段實作
- `M2_*.md`, `M3_*.md` - Milestone 2/3 實作記錄
- `PHASE*.md` - 各階段重構記錄
- `STEP*.md` - 步驟式實作記錄
- `TWO_STEP_GATE_*.md` - Two-step gate 實作
- `BATCH_UPSERT_*.md` - 批次上傳實作
- `DOMAIN_LAYER_*.md` - Domain layer 重構
- `UPLOAD_*.md` - 上傳功能優化記錄
- `SUPABASE_SERVICES_*.md` - Supabase 服務層重構
- `DATA_*.md` - 資料驗證/上傳 UI 實作
- `UI_*.md` - UI 元件實作記錄
- `PM_CONVERGENCE_*.md` - PM 收斂模型
- `RISK_DASHBOARD_*.md` - 風險儀表板實作
- `SAMPLE_DATA_*.md` - 範例資料清理
- `WEEK1_*.md` - Week 1 Demo 實作

### archive/troubleshooting/（問題修復）

包含各類問題修復與除錯記錄：

- `DIAGNOSTIC_*.md` - 診斷記錄
- `*_FIX.md` - 問題修復記錄
- `BUGFIX_*.md` - Bug 修復
- `UPLOAD_FIX_*.md` - 上傳功能修復

### archive/（其他歷史文件）

- 測試指南（`*_TEST.md`, `*_QA.md`）
- 檢查清單（`*_CHECKLIST.md`）
- 快速開始指南（`*_QUICK_START.md`）
- AI 提示工程記錄
- 舊版指南（已被新版取代）

---

## 📋 狀態定義

- 🟢 **Active**：目前仍在使用，必須遵循
- 🟡 **Outdated**：部分過時，僅供參考
- 🔴 **Deprecated**：已廢棄，僅保留歷史記錄

---

## 🔍 如何找到你需要的文件？

### 情境 1：我要理解系統架構
→ 閱讀 `guides/ARCHITECTURE_DESIGN.md` + `guides/DOMAIN_ARCHITECTURE_COMPLETE.md`

### 情境 2：我要實作資料上傳功能
→ 閱讀 `guides/UPLOAD_WORKFLOW_GUIDE.md` + `guides/DATA_VALIDATION_GUIDE.md`

### 情境 3：我要查詢資料庫 Schema
→ 閱讀 `guides/DATABASE_SCHEMA_GUIDE.md` + `guides/STEP1_SCHEMA_DEPLOYMENT_GUIDE.md`

### 情境 4：我要使用 One-shot Import
→ 閱讀 `guides/ONE_SHOT_FRAMEWORK_GUIDE.md`

### 情境 5：我要了解驗證規則
→ 閱讀 `guides/VALIDATION_RULES_QUICK_REFERENCE.md`

### 情境 6：我遇到問題，想找類似案例
→ 搜尋 `archive/troubleshooting/` 目錄

### 情境 7：我想了解某功能的演進歷史
→ 搜尋 `archive/summaries/` 目錄

---

## 🚨 文件維護規範

### ✅ DO（正確做法）

1. **新增文件時：**
   - 現行規範/架構 → 放入 `docs/guides/`
   - 實作總結/完成報告 → 放入 `docs/archive/summaries/`
   - 問題修復/除錯記錄 → 放入 `docs/archive/troubleshooting/`
   - 測試/QA 文件 → 放入 `docs/archive/`

2. **每個 guide 必須包含 metadata header：**
   ```markdown
   ---
   owner: team-name
   status: active | outdated | deprecated
   last_reviewed: YYYY-MM-DD
   ---
   ```

3. **更新文件時：**
   - 更新 `last_reviewed` 日期
   - 如果文件已過時，更新 `status` 並移至 `archive/`

### ❌ DON'T（禁止事項）

- ❌ 禁止在專案根目錄新增 `.md` 文件
- ❌ 禁止刪除任何歷史文件（只能移動）
- ❌ 禁止在 `guides/` 中放入超過 12 份文件
- ❌ 禁止在文件中寫死路徑或機密資訊

---

## 📊 文件統計

- **Active Guides**: 12 份
- **Archive Files**: 70+ 份
- **最後整理日期**: 2026-02-05

---

## 🔗 相關資源

- [專案根目錄 README](../README.md)
- [SQL Migrations](../sql/migrations/)
- [程式碼範例](../src/)
- [測試資料](../test_data_examples/)

---

*本索引由 AI Agent 自動產生並維護 | 如有疑問請參考 `.cursorrules`*
