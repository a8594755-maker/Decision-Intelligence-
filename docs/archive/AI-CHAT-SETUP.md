# Decision-Intelligence AI Chat 對話紀錄系統設置指南

## 🎯 新功能概覽

你的 Decision AI 模組現在升級為完整的對話管理系統,支援:

✅ **多對話管理** - 創建和管理多個獨立對話
✅ **自動標題** - 根據第一條訊息自動生成對話標題
✅ **永久保存** - 所有對話自動保存到 Supabase
✅ **時間追蹤** - 顯示相對時間 (1m ago, 2h ago)
✅ **對話刪除** - 支援刪除不需要的對話
✅ **訊息統計** - 顯示每個對話的訊息數量
✅ **切換對話** - 快速在不同對話間切換
✅ **上下文感知** - AI 會記住整個對話歷史

## 📋 資料庫設置步驟

### 步驟 1: 登入 Supabase Dashboard

1. 前往 https://supabase.com/dashboard
2. 選擇你的專案 (cbxvqqqulwytdblivtoe)

### 步驟 2: 執行 SQL 腳本

1. 在左側選單點擊 **"SQL Editor"**
2. 點擊 **"+ New query"**
3. 打開專案根目錄的 `supabase-setup.sql` 檔案
4. 複製所有內容並貼到 SQL Editor
5. 點擊 **"Run"** 執行腳本

### 步驟 3: 驗證資料表已創建

1. 在左側選單點擊 **"Table Editor"**
2. 確認看到以下資料表:
   - ✅ `conversations` (新建)
   - ✅ `user_files` (已存在或新建)

## 🗄️ 資料表結構

### conversations 資料表

| 欄位名稱 | 類型 | 說明 |
|---------|------|------|
| id | TEXT | 對話唯一 ID |
| user_id | UUID | 用戶 ID (外鍵到 auth.users) |
| title | TEXT | 對話標題 |
| messages | JSONB | 訊息陣列 |
| created_at | TIMESTAMPTZ | 創建時間 |
| updated_at | TIMESTAMPTZ | 最後更新時間 |

### 訊息格式 (messages JSONB)

```json
[
  {
    "role": "ai",
    "content": "Hello! How can I help you?",
    "timestamp": "2025-12-01T12:00:00.000Z"
  },
  {
    "role": "user",
    "content": "Analyze my data",
    "timestamp": "2025-12-01T12:01:00.000Z"
  }
]
```

## 🎨 使用者介面特性

### 左側邊欄 (Conversations)
- 📱 顯示所有對話列表
- 🔵 當前對話會以藍色高亮顯示
- ⏱️ 顯示最後更新時間
- 🗑️ 滑鼠懸停時顯示刪除按鈕
- ➕ 頂部有 "+ New" 按鈕

### 主聊天區域
- 💬 顯示完整對話歷史
- ⌚ 每條訊息顯示時間戳記
- 🎨 用戶訊息(藍色) vs AI 訊息(灰色)
- 🤖 AI 思考時顯示動畫
- 📊 顯示使用的資料行數

### 對話管理
- 🆕 **新建對話**: 點擊 "+ New" 按鈕
- 🔄 **切換對話**: 點擊左側列表中的對話
- 🗑️ **刪除對話**: 滑鼠懸停後點擊 X 按鈕
- 💾 **自動保存**: 每條訊息自動同步到雲端

## 🔐 安全特性

### Row Level Security (RLS)
- ✅ 每個用戶只能看到自己的對話
- ✅ 無法訪問其他用戶的資料
- ✅ 自動處理用戶刪除 (CASCADE)
- ✅ 所有操作都需要認證

## 🚀 使用流程

### 第一次使用

1. **登入應用程式**
2. **點擊 "Decision AI" 模組**
3. **點擊 "Start Chatting" 創建第一個對話**
4. **開始聊天!**

### 日常使用

1. **創建新對話**: 點擊 "+ New" → 確認
2. **切換對話**: 點擊左側列表中的對話
3. **繼續對話**: 在輸入框輸入訊息
4. **刪除對話**: 懸停在對話上 → 點擊 X

## 📊 資料流程

```
用戶輸入訊息
    ↓
儲存到本地 State (即時顯示)
    ↓
呼叫 Gemini AI API
    ↓
取得 AI 回應
    ↓
更新本地 State
    ↓
同步到 Supabase (永久保存)
```

## 🐛 故障排除

### 問題: 對話無法載入

**解決方案:**
1. 檢查 Supabase SQL Editor 是否成功執行腳本
2. 確認 `conversations` 資料表存在
3. 檢查瀏覽器 Console 是否有錯誤

### 問題: 無法創建新對話

**解決方案:**
1. 確認已登入
2. 檢查 RLS 策略是否正確設置
3. 查看 Network 標籤確認 API 請求

### 問題: 訊息不同步

**解決方案:**
1. 重新整理頁面
2. 檢查網路連線
3. 確認 Supabase 專案狀態

## 🔄 從舊版本遷移

如果你之前使用舊的 `chat_history` 資料表:

1. 舊資料不會自動遷移
2. 可以手動執行遷移腳本 (如需要)
3. 新系統使用 `conversations` 資料表
4. 舊資料可以保留或刪除

## 📈 未來擴展

可能的功能增強:

- 🏷️ 對話標籤和分類
- 🔍 對話內容搜尋
- 📤 導出對話為文件
- ⭐ 標記重要對話
- 📌 固定常用對話
- 🎨 自訂對話顏色
- 📊 對話統計分析

## 📞 技術支援

遇到問題? 請檢查:
1. 瀏覽器 Console 錯誤訊息
2. Supabase Dashboard → Table Editor
3. Supabase Dashboard → Authentication (確認用戶狀態)
4. Network 標籤查看 API 請求

---

**享受全新的 AI 對話體驗! 🎉**
