# SmartOps 供應鏈營運平台

React + Vite 打造的智能供應商績效與成本營運儀表板，整合 Supabase 雲端資料庫、Google Gemini AI 決策助手、Excel/CSV 匯入、KPI 視覺化、異常分析與自動化工作流程。

## 🌟 主要功能

### 📊 供應商管理
- **供應商主檔管理**：完整 CRUD 操作、進階搜尋與篩選
- **批次匯入**：支援 Excel/CSV，智能去重與驗證
- **AI 欄位映射**：自動識別欄位對應關係，減少手動設定
- **KPI 整合**：即時顯示供應商績效摘要

### 📈 KPI 與儀表板
- **收貨合格率**：追蹤供應商交付品質
- **準時交付率**：監控交期達成狀況
- **缺陷率分析**：識別品質問題趨勢
- **價格趨勢**：視覺化價格變動歷程
- **互動式圖表**：可篩選、縮放的動態儀表板

### 💰 材料成本分析（新功能）
- **成本結構分析**：自動計算材料成本占比
- **異常偵測**：識別價格異常與成本波動
- **AI 洞察報告**：Gemini AI 生成改善建議
- **歷史趨勢追蹤**：多期間成本比較分析
- 📖 詳見：[材料成本分析快速指南](MATERIAL_COST_QUICK_START.md)

### 📤 智能數據匯入系統
- **三大類型支援**：貨收記錄、價格歷史、供應商主檔
- **AI 自動映射**：智能欄位識別與建議
- **多工作表支援**：一次匯入多個 Excel 工作表
- **前端去重**：上傳前自動檢測重複記錄
- **智能合併**：提供更新、跳過、新增等合併選項
- **資料驗證**：15+ 種驗證規則確保資料品質
- **導入歷史追蹤**：完整記錄每次匯入操作與結果
- 📖 詳見：[數據上傳完整指南](DATA_UPLOAD_COMPLETE_GUIDE.md)

### 🤖 AI 決策助手
- **上下文對話**：基於當前數據的智能問答
- **多對話管理**：建立、切換、管理多個對話串
- **歷史記錄**：保存對話歷史供日後參考
- **行動建議**：針對成本異常提供具體改善方案

### 🔐 帳號與雲端同步
- **Supabase 認證**：安全的 Email/Password 登入
- **多租戶隔離**：每個用戶的資料完全獨立
- **雲端同步**：資料自動備份到雲端
- **檔案管理**：支援雲端備份與還原

## 🛠️ 技術堆疊

### 前端框架
- **React 19** - 現代化的用戶介面框架
- **Vite 7** - 快速的建置工具與開發伺服器
- **Tailwind CSS 4** - 實用優先的 CSS 框架
- **Lucide Icons** - 精美的開源圖示庫

### 後端服務
- **Supabase** 
  - PostgreSQL 資料庫
  - 即時資料同步
  - 認證與授權
  - 雲端儲存
  
### AI 整合
- **Google Gemini 2.5 Flash** 
  - 智能欄位映射
  - 成本分析與洞察
  - 對話式決策助手
  - 異常檢測與建議

### 資料處理
- **XLSX** - Excel 檔案解析與處理
- **Papa Parse** - CSV 檔案解析
- **Recharts** - 資料視覺化圖表庫

## 🚀 快速開始

### 1. 環境需求
- **Node.js** 18+ 
- **npm** 或 **yarn**
- **Supabase 帳號**（免費方案即可）
- **Google AI Studio 帳號**（取得 Gemini API Key）

### 2. 安裝步驟

```bash
# 複製專案
git clone https://github.com/your-username/smartops-app.git
cd smartops-app

# 安裝相依套件
npm install

# 啟動開發伺服器
npm run dev
```

預設開啟於 http://localhost:5173

### 3. 資料庫設定

執行以下 SQL 腳本建立資料庫結構：

```bash
# 快速設定（包含基本表格與範例資料）
執行 QUICK_SETUP.sql

# 或完整設定（包含所有表格、檢視、觸發器）
執行 database/supplier_kpi_schema.sql
執行 database/import_batches_schema.sql
執行 database/upload_mappings_schema.sql
執行 database/cost_analysis_schema.sql
```

📖 詳細說明請參考：[資料庫架構指南](DATABASE_SCHEMA_GUIDE.md)

### 4. 環境變數配置

**Supabase 設定**：
- 在 `src/services/supabaseClient.js` 設定您的 Supabase URL 與 Anon Key
- 建議正式環境使用 `.env.local`：
  ```
  VITE_SUPABASE_URL=your-supabase-url
  VITE_SUPABASE_ANON_KEY=your-anon-key
  ```

**Gemini API Key**：
- 方法 1：在應用程式的「Settings」介面輸入（儲存於 localStorage）
- 方法 2：設定環境變數 `VITE_GEMINI_API_KEY`
- 取得金鑰：https://ai.google.dev/

### 5. 首次登入
- 在 Supabase 後台的 Authentication 建立使用者
- 或在登入頁面使用註冊功能
- 登入後即可開始使用所有功能

## ⚙️ 環境設定說明

### 網路權限
- Gemini AI 需要外網連線
- Supabase 需設定允許的網域（CORS）
- 建議在 Supabase 後台設定網域白名單

### API 配額管理
- Gemini API 免費方案：15 requests/min
- 建議升級為付費方案以獲得更高配額
- 應用程式已內建錯誤處理與重試機制
- 📖 詳見：[Gemini API 配額問題](GEMINI_API_QUOTA_ISSUE.md)

## 🗄️ 資料庫架構

### 核心資料表
- **suppliers** - 供應商主檔
- **materials** - 物料主檔
- **goods_receipts** - 貨收記錄
- **price_history** - 價格歷史
- **import_batches** - 匯入批次記錄
- **upload_mappings** - 欄位映射模板
- **material_cost_analysis** - 材料成本分析

### KPI 檢視
- **supplier_kpi_summary** - 供應商 KPI 摘要
- **supplier_performance_stats** - 績效統計
- **material_price_trends** - 價格趨勢
- **cost_analysis_results** - 成本分析結果

### 資料庫管理
- **多租戶設計**：所有資料以 `user_id` 隔離
- **自動時間戳**：created_at / updated_at 自動維護
- **索引優化**：針對常用查詢建立複合索引
- **資料清理腳本**：[重置所有資料](HOW_TO_RESET_DATA.md)

📖 完整說明：[資料庫架構指南](DATABASE_SCHEMA_GUIDE.md)

## 📋 資料匯入欄位需求

### 貨收記錄（Goods Receipt）
**必填欄位**：
- `supplier_name` - 供應商名稱
- `material_code` - 物料代碼
- `actual_delivery_date` - 實際交付日期
- `received_qty` - 收貨數量

**選填欄位**：
- `supplier_code`, `material_name`, `po_number`, `receipt_number`
- `planned_delivery_date`, `receipt_date`, `rejected_qty`
- `category`, `uom` (單位)

### 價格歷史（Price History）
**必填欄位**：
- `supplier_name` - 供應商名稱
- `material_code` - 物料代碼
- `order_date` - 訂單日期
- `unit_price` - 單位價格

**選填欄位**：
- `supplier_code`, `material_name`, `currency`
- `quantity`, `is_contract_price`

### 供應商主檔（Supplier Master）
**必填欄位**：
- `supplier_name` - 供應商名稱

**選填欄位**：
- `supplier_code` - 供應商代碼
- `contact_person` - 聯絡人
- `phone`, `email`, `address`
- `product_category` - 產品類別
- `payment_terms` - 付款條件
- `delivery_time` - 交期
- `status` - 狀態

### 檔案限制
- 支援格式：Excel (.xlsx, .xls) 或 CSV
- 檔案大小：≤ 10MB
- 編碼：UTF-8（CSV 檔案）
- 多工作表：支援一次匯入多個工作表

📖 詳細指南：
- [數據上傳完整指南](DATA_UPLOAD_COMPLETE_GUIDE.md)
- [數據驗證指南](DATA_VALIDATION_GUIDE.md)
- [AI 映射指南](AI_MAPPING_GUIDE.md)

## 📁 專案結構

```
smartops-app/
├── src/
│   ├── App.jsx                          # 主應用程式、路由與佈局
│   ├── main.jsx                         # 應用程式入口
│   │
│   ├── views/                           # 主要視圖元件
│   │   ├── SupplierManagementView.jsx   # 供應商管理介面
│   │   ├── CostAnalysisView.jsx         # 成本分析介面
│   │   ├── EnhancedExternalSystemsView.jsx # 數據匯入介面
│   │   └── ImportHistoryView.jsx        # 匯入歷史介面
│   │
│   ├── services/                        # 服務層
│   │   ├── supabaseClient.js            # Supabase 連線設定
│   │   ├── geminiAPI.js                 # Gemini AI 整合
│   │   ├── supplierKpiService.js        # 供應商 KPI 服務
│   │   ├── materialCostService.js       # 材料成本服務
│   │   └── importHistoryService.js      # 匯入歷史服務
│   │
│   ├── utils/                           # 工具函式
│   │   ├── dataValidation.js            # 資料驗證規則
│   │   ├── dataProcessing.js            # 資料處理與轉換
│   │   ├── dataCleaningUtils.js         # 資料清洗工具
│   │   ├── aiMappingHelper.js           # AI 映射輔助
│   │   └── uploadSchemas.js             # 上傳架構定義
│   │
│   └── components/                      # 可重用元件
│       ├── ui/                          # UI 基礎元件
│       │   ├── Button.jsx
│       │   ├── Card.jsx
│       │   ├── Modal.jsx
│       │   └── Badge.jsx
│       └── charts/                      # 圖表元件
│           ├── SimpleBarChart.jsx
│           └── SimpleLineChart.jsx
│
├── database/                            # 資料庫腳本
│   ├── supplier_kpi_schema.sql          # KPI 資料表與檢視
│   ├── import_batches_schema.sql        # 匯入批次架構
│   ├── upload_mappings_schema.sql       # 映射模板架構
│   ├── cost_analysis_schema.sql         # 成本分析架構
│   ├── reset_all_data.sql               # 資料重置腳本
│   └── cleanup_duplicate_suppliers.sql  # 去重腳本
│
├── test_data_examples/                  # 測試資料範例
│   └── supplier_master_test_cases.md
│
└── docs/                                # 文檔（Markdown 檔案）
    ├── 功能指南/
    ├── 故障排除/
    └── 實作說明/
```

## 💻 常用指令

### 開發
```bash
npm run dev          # 啟動開發伺服器（熱重載）
npm run lint         # 執行 ESLint 檢查
```

### 建置與部署
```bash
npm run build        # 建置生產版本
npm run preview      # 預覽生產建置
```

### 資料庫管理
```bash
# 在 Supabase SQL Editor 執行：
# 1. 初始設定：QUICK_SETUP.sql
# 2. 清理資料：database/reset_all_data.sql
# 3. 去除重複：database/cleanup_duplicate_suppliers.sql
```

## 📚 完整文檔

### 快速開始指南
- [材料成本分析快速指南](MATERIAL_COST_QUICK_START.md)
- [數據上傳完整指南](DATA_UPLOAD_COMPLETE_GUIDE.md)
- [資料庫架構指南](DATABASE_SCHEMA_GUIDE.md)

### 功能說明
- [成本分析指南](COST_ANALYSIS_GUIDE.md)
- [供應商驗證指南](SUPPLIER_VALIDATION_GUIDE.md)
- [匯入歷史指南](IMPORT_HISTORY_GUIDE.md)
- [AI 映射指南](AI_MAPPING_GUIDE.md)
- [映射模板指南](MAPPING_TEMPLATE_GUIDE.md)

### 新功能
- [前端去重功能](FRONTEND_DEDUPLICATION.md)
- [智能合併功能](SMART_MERGE_FEATURE.md)
- [多工作表支援](MULTI_SHEET_SUPPORT.md)
- [重複檢查功能](DUPLICATE_CHECK_FEATURE.md)

### 故障排除
- [成本分析故障排除](COST_ANALYSIS_TROUBLESHOOTING.md)
- [AI 映射故障排除](AI_MAPPING_TROUBLESHOOTING.md)
- [Gemini API 配額問題](GEMINI_API_QUOTA_ISSUE.md)
- [價格歷史映射修復](PRICE_HISTORY_MAPPING_FIX.md)

### 實作說明
- [材料成本實作](MATERIAL_COST_IMPLEMENTATION.md)
- [匯入歷史實作](IMPORT_HISTORY_SUMMARY.md)
- [供應商驗證實作](SUPPLIER_VALIDATION_IMPLEMENTATION.md)
- [架構設計文件](ARCHITECTURE_DESIGN.md)

## ⚠️ 注意事項

### 安全性
- ⚠️ **請務必替換示範用的 API 金鑰**
- 建議將所有敏感資訊移至環境變數
- 正式環境請設定 Supabase CORS 白名單
- 定期更新相依套件以修補安全漏洞

### 資料管理
- 匯入前請確保資料庫表格已建立
- 大量資料匯入建議分批處理
- 定期備份重要資料
- 使用 [資料重置腳本](HOW_TO_RESET_DATA.md) 清理測試資料

### API 配額
- Gemini API 免費方案有請求限制
- 建議實作快取機制減少 API 呼叫
- 監控 API 使用量避免超額
- 考慮升級至付費方案

### 效能優化
- 大型 Excel 檔案建議先壓縮或分割
- 使用索引加速資料庫查詢
- 前端分頁與虛擬滾動處理大量資料
- 適當使用 React.memo 避免不必要的重新渲染

## 🤝 貢獻

歡迎提交 Issue 或 Pull Request！

## 📄 授權

本專案採用 MIT 授權條款。

---

**SmartOps** - 讓供應鏈管理更智能、更高效 🚀
