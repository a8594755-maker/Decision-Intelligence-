# 🔒 安全部署指南

## ⚠️ 重要安全提醒

本專案已將敏感憑證從代碼中移除，改用環境變數管理。在公開或部署此專案前，請務必完成以下步驟。

---

## 📋 部署前檢查清單

### ✅ 必須完成的步驟

- [ ] **撤銷已暴露的 API 密鑰**（最重要！）
- [ ] **重新生成新的 API 密鑰**
- [ ] **配置環境變數**
- [ ] **測試應用功能正常**
- [ ] **確認 `.env` 文件不會被 Git 追蹤**

---

## 🔑 撤銷和重新生成 API 密鑰

### 1. Supabase 數據庫憑證

**為什麼需要撤銷？**
舊的 Supabase API Key 已在代碼歷史中暴露，任何人都可以從 Git 歷史中找到並使用它。

**如何重新生成：**

1. 登入 [Supabase Dashboard](https://supabase.com/dashboard)
2. 選擇您的專案
3. 前往 **Settings** → **API**
4. 在 **Project API keys** 區域：
   - 找到 `anon` `public` key
   - 點擊 **Reset** 重新生成
5. 複製新的 API Key
6. 更新本地 `.env` 文件中的 `VITE_SUPABASE_ANON_KEY`

**注意：** Supabase URL 通常不需要更改，但 API Key 必須重新生成。

### 2. Google Gemini API Key

**為什麼需要撤銷？**
舊的 API Key 已暴露，可能被濫用並產生配額費用。

**如何重新生成：**

1. 前往 [Google AI Studio](https://aistudio.google.com/app/apikey)
2. 登入您的 Google 帳號
3. 找到現有的 API Key：`AIzaSyBiPV68i9HR_D6a_PQ3lwSEJSIYZ0eF3j4`
4. 點擊 **刪除** 或 **撤銷** 該 Key
5. 點擊 **Create API Key** 創建新的 Key
6. 複製新的 API Key
7. 更新本地 `.env` 文件中的 `VITE_GEMINI_API_KEY`

---

## 🛠️ 環境變數配置

### 本地開發環境

1. **確保 `.env` 文件存在**
   
   在專案根目錄應該有 `.env` 文件（已自動創建）

2. **更新 `.env` 文件內容**

   ```env
   # Supabase Configuration
   VITE_SUPABASE_URL=https://cbxvqqqulwytdblivtoe.supabase.co
   VITE_SUPABASE_ANON_KEY=<您的新 Supabase Key>

   # Google Gemini AI API
   VITE_GEMINI_API_KEY=<您的新 Gemini Key>
   ```

3. **重新啟動開發伺服器**

   ```bash
   npm run dev
   ```

### 生產環境部署

根據不同的部署平台，配置方式略有不同：

#### Vercel

1. 前往專案的 **Settings** → **Environment Variables**
2. 添加以下變數：
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_GEMINI_API_KEY`
3. 重新部署專案

#### Netlify

1. 前往專案的 **Site settings** → **Environment variables**
2. 添加相同的環境變數
3. 觸發重新部署

#### 其他平台

查詢該平台的環境變數設置文檔，確保在構建時可用。

---

## 🧪 驗證配置

### 1. 檢查 `.env` 文件是否被 Git 忽略

```bash
git status
```

**不應該看到 `.env` 文件被列出**。如果看到了，請執行：

```bash
git rm --cached .env
```

### 2. 測試應用功能

啟動開發伺服器並測試：

```bash
npm run dev
```

- ✅ 應用能正常啟動
- ✅ 能夠連接 Supabase 數據庫
- ✅ AI 功能可以正常使用
- ✅ 控制台沒有出現 "Missing environment variables" 錯誤

### 3. 檢查環境變數是否正確載入

在瀏覽器控制台執行：

```javascript
console.log('Supabase URL:', import.meta.env.VITE_SUPABASE_URL)
console.log('Has Supabase Key:', !!import.meta.env.VITE_SUPABASE_ANON_KEY)
console.log('Has Gemini Key:', !!import.meta.env.VITE_GEMINI_API_KEY)
```

應該看到 URL 和兩個 `true` 值。

---

## 📦 Git 提交指南

### 首次提交（清理密鑰）

如果您之前已經提交過包含密鑰的代碼：

```bash
# 添加所有修改
git add .

# 提交更改
git commit -m "security: 移除硬編碼的 API 密鑰，改用環境變數"

# 推送到遠端
git push origin master
```

### 重要提示

- ✅ **可以提交**: `.env.example`（不含真實密鑰）
- ❌ **絕不提交**: `.env`（含真實密鑰）
- ❌ **絕不提交**: 任何包含真實密鑰的文件

---

## 🚨 萬一密鑰再次洩露怎麼辦？

1. **立即撤銷密鑰**（按照上面的步驟）
2. **檢查 Git 歷史**，確保新密鑰沒有被提交
3. **重新生成新的密鑰**
4. **考慮使用 `.git-crypt` 或類似工具加密敏感文件**

---

## 📚 相關文件

- [Supabase 文檔](https://supabase.com/docs)
- [Google Gemini API 文檔](https://ai.google.dev/docs)
- [Vite 環境變數指南](https://vitejs.dev/guide/env-and-mode.html)

---

## ❓ 常見問題

### Q: 為什麼使用 `VITE_` 前綴？

A: Vite 要求客戶端可訪問的環境變數必須以 `VITE_` 開頭，這是安全機制，防止意外暴露伺服器端的敏感變數。

### Q: `.env` 文件在哪裡？

A: 在專案根目錄，與 `package.json` 同級。如果看不到，可能是因為操作系統隱藏了以 `.` 開頭的文件。

### Q: 可以公開 Supabase URL 嗎？

A: 可以。Supabase URL 不是敏感資訊，它只是數據庫的端點地址。真正敏感的是 `anon key`。

### Q: 部署後 AI 功能不工作？

A: 檢查：
1. 環境變數是否正確設置在部署平台
2. Gemini API Key 是否有效且有配額
3. 瀏覽器控制台是否有錯誤訊息

---

## ✅ 完成確認

完成所有步驟後，您的專案應該：

- ✅ 代碼中沒有硬編碼的密鑰
- ✅ `.env` 文件不會被 Git 追蹤
- ✅ 舊的密鑰已被撤銷
- ✅ 應用使用新密鑰正常運行
- ✅ 可以安全地公開到 GitHub

**現在可以放心地將代碼推送到公開的 GitHub 倉庫了！** 🎉

