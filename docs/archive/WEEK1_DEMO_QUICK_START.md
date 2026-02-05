# Week 1 Risk Dashboard 快速測試指南

## 🚀 快速開始（2 分鐘）

### 方法 1：使用 Sample Data（推薦，無需資料）

1. **啟動應用**
   ```bash
   npm run dev
   ```

2. **進入 Risk Dashboard**
   - 登入後點擊側邊欄的「Risk Dashboard」

3. **載入測試資料**
   - 點擊右上角的 "Load Sample Data" 按鈕
   - 立即看到 20 條測試資料（包含 3+ CRITICAL、5+ WARNING）

4. **測試交互**
   - ✅ 查看 4 個 KPI Cards（Critical count、Shortage、Profit、Time）
   - ✅ 使用 Filter Bar（工廠下拉、料號搜索、狀態篩選）
   - ✅ 點擊表格標題排序
   - ✅ 點擊任一行查看右側詳情面板
   - ✅ 在詳情面板查看「未來 30 天內 PO 明細（Top 5）」

---

## 📊 方法 2：使用真實資料

### 前置需求
- 已上傳 `po_open_lines.xlsx`（**必需**）
- 已上傳 `inventory_snapshots.xlsx`（選填，無此資料時庫存為 0）

### 測試步驟

1. **準備資料**
   - 前往「外部系統資料」頁面
   - 上傳 `templates/po_open_lines.xlsx`
   - （選填）上傳 `templates/inventory_snapshots.xlsx`

2. **查看 Risk Dashboard**
   - 點擊側邊欄的「Risk Dashboard」
   - 等待資料載入（應該顯示實際筆數）

3. **驗證資料**
   - KPI Cards 顯示正確數量
   - 表格中有資料且排序正確
   - 點擊行後右側詳情面板顯示

---

## 🎯 測試重點

### 1. KPI Cards
- **Critical Count**：顯示未來 30 天無入庫的料號數量
- **Shortage within Horizon**：顯示 30 天內可能斷料的數量
- **Profit at Risk**：顯示 $0（Coming Week 2）
- **Snapshot Time**：顯示資料批次時間

### 2. Filter Bar
- **工廠篩選**：下拉選單應包含所有工廠代碼
- **料號搜索**：輸入關鍵字即時篩選
- **狀態篩選**：Critical / Warning / OK
- **清除篩選**：一鍵清除所有篩選條件
- **Export**：目前 disabled（Week 2 功能）

### 3. 風險表格
- **預設排序**：CRITICAL → WARNING → OK，再按 Next inbound ETA
- **點擊排序**：點擊任一欄位標題可切換升降序
- **行選取**：點擊任一行後該行高亮並顯示右側詳情

### 4. 詳情面板（右側）
應顯示：
- ✅ 風險警示區（為什麼是 Critical/Warning）
- ✅ 庫存狀況（On hand、Safety stock、Net available）
- ✅ 未來 30 天供需（Inbound qty、Required、Net）
- ✅ 風險指標（Days to stockout、Shortage date、Gap qty、Probability）
- ✅ **未來 30 天內 PO 明細（Top 5）**：
  - PO 統計摘要（Inbound count、Total qty、Next ETA）
  - PO 列表（每條含 PO Number、ETA、Qty）
  - 若無 PO 則顯示紅色警告

---

## 🔍 預期結果（Sample Data 模式）

### CRITICAL 項目（至少 3 條）
- **Reason**：「未來 30 天無入庫」
- **Inbound Count**：0
- **狀態**：紅色 🔴 Critical
- **PO 明細**：顯示「未來 30 天內無 PO」警告

### WARNING 項目（至少 5 條）
- **Reason**：
  - 「下次入庫距今 X 天 (> 14 天)」，或
  - 「未來 30 天僅 1 次入庫」
- **Inbound Count**：1 或多次
- **狀態**：黃色 🟡 WARNING
- **PO 明細**：顯示 1-5 條 PO

### OK 項目（其餘）
- **Reason**：「有 X 次入庫，供應正常」
- **Inbound Count**：2+ 次
- **狀態**：綠色 🟢 OK
- **PO 明細**：顯示 2-5 條 PO

---

## 🐛 常見問題

### Q1: 點擊「Load Sample Data」後沒反應？
**A:** 檢查瀏覽器 Console 是否有錯誤訊息，確保程式碼已正確部署。

### Q2: 使用真實資料時顯示「尚無 Open PO 資料」？
**A:** 請先上傳 `po_open_lines.xlsx`，此為必需資料。

### Q3: 詳情面板顯示「未來 30 天內無 PO」但 Inbound Count 不為 0？
**A:** 檢查 PO 的 ETA 欄位是否正確，應為未來 30 天內的日期。

### Q4: 表格中顯示 (unknown)？
**A:** 來源資料缺少料號欄位，檢查 Excel 檔案是否有 `item` / `material_code` 欄位。

### Q5: 為什麼 Sample Data 的庫存都不為 0？
**A:** Sample Data 生成器會自動產生 100-600 件的隨機庫存快照。

---

## 📸 預期畫面

### 頁面頂部
```
🚨 Supply Coverage Risk
Horizon: 30 days · 最後更新: 2026-02-04 14:30 【Sample Data 模式】

[Load Sample Data] [重新整理]
```

### KPI Cards（並排顯示）
```
┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│ 🔴 3           │ │ 🟡 5           │ │ 💲 $0          │ │ 🕐 2026-02-04  │
│ Critical 風險項│ │ 30 天內斷料    │ │ Profit at Risk │ │ 資料批次時間   │
│ 總計 20 料號   │ │ Days ≤ 30     │ │ Coming Week 2  │ │ ✓ 資料已同步   │
└────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘
```

### Filter Bar
```
┌──────────────────────────────────────────────────────────────┐
│ 🔍 篩選  [全部工廠 ▼]  [🔍 搜尋料號...]  [全部等級 ▼]  [清除] [Export] │
└──────────────────────────────────────────────────────────────┘
```

### 表格 + 詳情面板
```
┌─────────────────────────────────────┬─────────────────────────┐
│ 風險清單               共 20 筆     │ 🔴 PART-A101           │
├─────────────────────────────────────┤                         │
│ 料號    │工廠 │狀態│Days│Next ETA  │ 工廠: FAC-TW01         │
├─────────┼─────┼────┼────┼──────────┤                         │
│PART-A101│TW01 │🔴  │ ∞  │ N/A     ◄│ ⚠️ 為什麼是 Critical？ │
│PART-B202│CN01 │🔴  │ ∞  │ N/A      │ • 未來 30 天內無入庫   │
│PART-C303│US01 │🔴  │ ∞  │ N/A      │                         │
│PART-D404│JP01 │🟡  │ 16 │2026-02-20│ 📦 庫存狀況            │
│PART-E505│TW01 │🟡  │ 18 │2026-02-22│ On hand: 250           │
│...                                  │ Safety stock: 0        │
│                                     │ Net available: 250     │
│                                     │                         │
│                                     │ 📅 未來 30 天內 PO 明細│
│                                     │ Inbound count: 0 次    │
│                                     │                         │
│                                     │ ⚠️ 未來 30 天內無 PO   │
│                                     │ 建議盡快確認補貨計畫   │
└─────────────────────────────────────┴─────────────────────────┘
```

---

## ✅ 驗收標準

- [ ] 可點擊「Load Sample Data」載入測試資料
- [ ] KPI Cards 顯示正確數量（Critical ≥ 3、Warning ≥ 5）
- [ ] Filter Bar 所有功能正常（工廠、搜索、狀態、清除）
- [ ] 表格可排序（點擊標題）
- [ ] 表格預設排序為 CRITICAL → WARNING → OK
- [ ] 點擊行後右側顯示詳情面板
- [ ] 詳情面板顯示「未來 30 天內 PO 明細（Top 5）」
- [ ] CRITICAL 項目顯示「未來 30 天內無 PO」警告
- [ ] WARNING/OK 項目顯示 PO 列表（含 PO Number、ETA、Qty）
- [ ] 頁面顯示【Sample Data 模式】標籤

---

## 🎉 Demo 完成

恭喜！您已成功完成 Week 1 Risk Dashboard 的測試。

**下一步：**
- Week 2：實現 Export CSV、Profit at Risk、趨勢圖表
- 上傳真實資料進行生產環境測試

**問題回報：**
如有任何問題，請參考 `WEEK1_RISK_DASHBOARD_IMPLEMENTATION.md` 的技術細節。
