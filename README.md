# SmartOps 供應鏈營運平台

React + Vite 打造的供應商績效與成本營運儀表板，整合 Supabase 登入/資料層、Google Gemini AI 決策助手、Excel/CSV 匯入、KPI 視覺化與異常分析。

## 主要功能
- 供應商主檔：查詢、搜尋、CRUD、批次匯入（Excel/CSV），並串接 KPI 摘要
- KPI 與儀表板：收貨合格率、準時交付率、缺陷率、價格/成本趨勢
- 外部系統數據匯入精靈：支援貨收、價格歷史、供應商主檔三類上傳，AI 欄位對應、資料清洗與驗證
- 成本分析：自動產生成本結構、異常偵測、Gemini AI 行動建議與報告摘要
- 決策聊天助手：以當前資料上下文回答、建立對話、管理歷史
- 帳號與雲端同步：Supabase Email/Password 登入、檔案雲端備份/還原

## 技術堆疊
- React 19 + Vite 7
- Supabase（Auth、Postgres、Storage）
- Google Gemini 2.5 Flash（AI 分析與對話）
- XLSX 解析、Tailwind 4（透過 `@tailwindcss/vite`）、Lucide 圖示

## 快速開始
1) 安裝環境：Node.js 18+  
2) 安裝套件：`npm install`  
3) 本地開發：`npm run dev`（預設 http://localhost:5173）  
4) 建置產物：`npm run build`，本地預覽：`npm run preview`  
5) 登入：使用你的 Supabase Email/Password 帳號；首次可在 Supabase 後台建立使用者。

## 環境設定
- Supabase：目前在 `src/services/supabaseClient.js` 直接指定 `supabaseUrl` 與 `supabaseKey`。正式環境請改為環境變數（例如 `.env.local` 中設定 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`，並在程式中讀取）。  
- Gemini API Key：UI 的「Settings」可輸入並存入 `localStorage`；預設程式含示範用 key，請換成自己的金鑰（可於 https://ai.google.dev/ 取得）。  
- 網路權限：呼叫 Gemini 需要外網；Supabase 需允許對應網域。

## 資料庫與 Schema
- 完整 SQL 在 `database/supplier_kpi_schema.sql`（包含 suppliers、materials、goods_receipts、price_history、KPI 匯總與統計檢視、觸發器）。  
- 匯入方式：將 SQL 貼入 Supabase SQL Editor 或 psql 執行。  
- 欄位與索引已為多租戶（`user_id`）與常用查詢優化設計。

## 匯入欄位需求（Enhanced External Systems View）
- 貨收（goods_receipt）：`supplier_name`, `material_code`, `actual_delivery_date`, `received_qty`（選填：`supplier_code`, `material_name`, `po_number`, `receipt_number`, `planned_delivery_date`, `receipt_date`, `rejected_qty`, `category`, `uom`）  
- 價格歷史（price_history）：`supplier_name`, `material_code`, `order_date`, `unit_price`（選填：`supplier_code`, `material_name`, `currency`, `quantity`, `is_contract_price`）  
- 供應商主檔（supplier_master）：`supplier_name`（選填：`supplier_code`, `contact_person`, `phone`, `email`, `address`, `product_category`, `payment_terms`, `delivery_time`, `status`）  
- 支援 Excel/CSV，大小 ≤ 10MB，並提供 AI 欄位對應與清洗驗證。

## 專案結構
- `src/App.jsx`：主應用、視圖切換、登入、通知、主佈局
- `src/views/`：`SupplierManagementView`、`CostAnalysisView`、`EnhancedExternalSystemsView`
- `src/services/`：`supabaseClient`、`geminiAPI`、`supplierKpiService` 等資料與 AI 服務
- `src/utils/`：資料處理、清洗、欄位偵測、分頁與排序
- `database/`：資料庫 schema 與 KPI 相關檢視

## 常用指令
- 開發：`npm run dev`
- Lint：`npm run lint`
- 建置：`npm run build`
- 預覽：`npm run preview`

## 注意事項
- 請替換成自己的 Supabase URL/Anon Key 與 Gemini API Key，避免使用示範憑證。
- 建議將金鑰移至環境變數並設定 CORS/網域白名單再部署。
- 匯入前請先建立對應的表與檢視，以確保 KPI 與統計查詢正常運作。
