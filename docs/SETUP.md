# Decision-Intelligence 環境設定指南

> 本文件說明如何從零開始設定本機開發環境。部署拓撲、Supabase migration 清單與 Edge Functions 佈署請以 [DEPLOYMENT.md](./DEPLOYMENT.md) 為準。

## 📋 目錄

- [系統需求](#系統需求)
- [安裝步驟](#安裝步驟)
- [資料庫設定](#資料庫設定)
- [環境變數設定](#環境變數設定)
- [常見問題](#常見問題)

---

## 系統需求

### 軟體需求

- **Node.js**: 22.x（與 CI 一致，18+ 亦可）
- **npm**: 10.x（或相容版本）
- **Python**: 3.12（ML API 推薦版本）
- **瀏覽器**: Chrome 90+, Firefox 88+, Safari 14+

### 外部服務

- **Supabase 帳號**: [註冊免費方案](https://supabase.com)
- **Google AI Studio**: [取得 Gemini API Key](https://ai.google.dev/)
- **DeepSeek 帳號**: 供 `ai-proxy` 使用

---

## 安裝步驟

### 1. Clone 專案

```bash
git clone https://github.com/a8594755-maker/Decision-Intelligence-.git
cd Decision-Intelligence-
```

### 2. 安裝依賴

```bash
npm ci
```

**安裝的主要套件**:
- React 19
- Vite 7
- Tailwind CSS 4
- Supabase JS Client
- XLSX (Excel 處理)
- Recharts (圖表)
- Lucide Icons

### 3. 複製環境變數範本

```bash
cp .env.example .env.local
```

---

## 資料庫設定

### Step 1: 建立 Supabase 專案

1. 前往 [Supabase Dashboard](https://supabase.com/dashboard)
2. 點擊 **New Project**
3. 填寫專案資訊:
   - Name: `decision-intelligence-production` (或自訂名稱)
   - Database Password: **記住此密碼**
   - Region: 選擇最近的區域 (例如: Singapore)
4. 等待專案建立完成 (約 2-3 分鐘)

### Step 2: 取得連線資訊

1. 在專案 Dashboard 中,前往 **Settings** > **API**
2. 複製以下資訊:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public key**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

### Step 3: 執行資料庫 Schema

請使用 `sql/migrations/` 下的 curated baseline，而不是手動拼湊零散 SQL。建議最少依序執行：

```text
sql/migrations/supabase-setup.sql
sql/migrations/supplier_kpi_schema.sql
sql/migrations/import_batches_schema.sql
sql/migrations/upload_mappings_schema.sql
sql/migrations/step1_supply_inventory_financials_schema.sql
sql/migrations/bom_forecast_schema.sql
sql/migrations/ingest_rpc.sql
sql/migrations/release_ingest_rpc_permissions.sql
```

可選強化項目請參考 [DEPLOYMENT.md](./DEPLOYMENT.md)。

2. **驗證安裝**:
   ```sql
   -- 檢查所有表是否建立
   SELECT table_name 
   FROM information_schema.tables 
   WHERE table_schema = 'public'
   ORDER BY table_name;
   
   -- 預期看到以下表:
   -- suppliers, materials, goods_receipts, price_history
   -- import_batches, upload_mappings
   -- bom_edges, demand_fg, component_demand, component_demand_trace
   -- operational_costs, cost_anomalies
   ```

3. **檢查 RLS (Row Level Security)**:
   ```sql
   SELECT tablename, rowsecurity 
   FROM pg_tables 
   WHERE schemaname = 'public';
   ```
   
   確保所有表的 `rowsecurity` 都是 `true`。

### Step 4: 設定認證

1. 前往 **Authentication** > **Settings**
2. 啟用 **Email Auth**
3. 設定 **Email Templates** (可選)
4. 建立測試使用者:
   - 前往 **Authentication** > **Users**
   - 點擊 **Invite User**
   - 輸入測試 Email

---

## 環境變數設定

複製 `.env.example` 成 `.env.local`，再依實際環境調整：

```bash
cp .env.example .env.local
```

最小可運作範例：

```bash
VITE_ENV=development
VITE_SUPABASE_URL=https://decision-intelligence-dev.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dev-anon-key
VITE_ML_API_URL=http://127.0.0.1:8000
VITE_DI_GEMINI_MODEL=gemini-3.1-pro-preview
VITE_DI_DEEPSEEK_MODEL=deepseek-chat
DI_SOLVER_ENGINE=ortools
DI_CHRONOS_ENABLED=false
USE_MOCK_ERP=true
```

AI provider key 不應放在前端 `.env.local`，請改用 Supabase Edge Function secrets：

```bash
supabase secrets set GEMINI_API_KEY=...
supabase secrets set DEEPSEEK_API_KEY=...
supabase secrets set FRONTEND_ORIGIN=http://localhost:5173
```

---

## 啟動應用

### 開發模式

```bash
npm run dev
```

應用會在 `http://localhost:5173` 啟動。

### ML API

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements-ml.txt
python run_ml_api.py
```

### 生產建置

```bash
npm run build
npm run preview
```

### 建置產出

建置後的檔案在 `dist/` 目錄,可以部署到:
- Vercel
- Netlify
- Cloudflare Pages
- 任何靜態檔案伺服器

---

## 驗證安裝

### 1. 檢查清單

- [ ] Node.js 版本 ≥ 18
- [ ] npm install 成功
- [ ] Supabase 專案建立完成
- [ ] 所有資料庫表建立完成
- [ ] RLS 政策啟用
- [ ] 環境變數設定完成
- [ ] 應用可以啟動 (`npm run dev`)
- [ ] 可以登入/註冊

### 2. 功能測試

登入後測試以下功能:

1. **Data Upload**:
   - 上傳測試 Excel 檔案
   - 完成欄位映射
   - 驗證並儲存

2. **Import History**:
   - 查看上傳記錄
   - 預覽資料
   - 測試 Undo 功能

3. **Forecasts**:
   - 執行 BOM Explosion
   - 查看結果
   - 匯出 CSV

---

## 常見問題

### Q1: npm install 失敗?

**可能原因**:
- Node.js 版本過舊
- 網路問題

**解決方法**:
```bash
# 升級 Node.js
nvm install 18
nvm use 18

# 清除快取重新安裝
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

### Q2: Supabase 連線錯誤?

**錯誤訊息**: `Failed to connect to Supabase`

**解決方法**:
1. 確認 `supabaseUrl` 和 `supabaseKey` 正確
2. 檢查網路連線
3. 確認 Supabase 專案狀態正常
4. 檢查防火牆設定

### Q3: RLS 政策錯誤?

**錯誤訊息**: `new row violates row-level security policy`

**解決方法**:
```sql
-- 檢查 RLS 政策
SELECT * FROM pg_policies WHERE tablename = 'suppliers';

-- 重新執行 schema SQL
-- 確保所有政策都已建立
```

### Q4: Gemini AI 不工作?

**可能原因**:
- API Key 無效
- 超過免費額度
- 網路問題

**解決方法**:
1. 前往 [Google AI Studio](https://ai.google.dev/) 檢查 API Key
2. 檢查 API 使用量
3. 在瀏覽器 Console 查看詳細錯誤

### Q5: 資料上傳後看不到?

**可能原因**:
- 未等待儲存完成
- RLS 政策問題
- user_id 不匹配

**解決方法**:
```sql
-- 檢查資料是否存在
SELECT COUNT(*) FROM suppliers WHERE user_id = auth.uid();

-- 檢查當前使用者
SELECT auth.uid();

-- 檢查 import_batches
SELECT * FROM import_batches WHERE user_id = auth.uid() ORDER BY created_at DESC;
```

---

## 進階設定

### CORS 設定 (生產環境)

在 Supabase Dashboard:
1. 前往 **Settings** > **API** > **CORS**
2. 添加允許的網域:
   ```
   https://your-app-domain.com
   https://www.your-app-domain.com
   ```

### 自訂網域 (生產環境)

在 Supabase Dashboard:
1. 前往 **Settings** > **Custom Domains**
2. 添加自訂網域
3. 設定 DNS CNAME 記錄
4. 等待 SSL 憑證自動配置

### 效能優化

1. **啟用 Supabase CDN**:
   - 自動啟用,無需設定

2. **前端快取策略**:
   - 在 `vite.config.js` 設定 build cache
   - 使用 Service Worker (PWA)

3. **資料庫索引優化**:
   ```sql
   -- 檢查索引使用情況
   SELECT * FROM pg_stat_user_indexes;
   
   -- 添加必要索引 (已在 schema 中定義)
   ```

---

## 後續步驟

✅ 環境設定完成後:

1. 閱讀 [DATA_UPLOAD_COMPLETE_GUIDE.md](./DATA_UPLOAD_COMPLETE_GUIDE.md) 了解上傳流程
2. 閱讀 [BOM_EXPLOSION.md](./docs/BOM_EXPLOSION.md) 了解 BOM 功能
3. 參考 [ARCHITECTURE_DESIGN.md](./ARCHITECTURE_DESIGN.md) 了解系統架構
4. 查看 [DATABASE_SCHEMA_GUIDE.md](./DATABASE_SCHEMA_GUIDE.md) 了解資料結構

---

## 取得支援

- **文件**: 查看 `docs/` 目錄
- **問題回報**: GitHub Issues
- **社群**: GitHub Discussions

---

**設定完成!** 🎉 現在可以開始使用 Decision-Intelligence 了!
