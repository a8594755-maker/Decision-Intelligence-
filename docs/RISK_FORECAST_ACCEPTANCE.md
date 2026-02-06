# Risk–Forecast Linkage 驗收腳本（Demo 用）

以下 8 步可對主管／客戶操作示範，預期結果請依實際資料微調。

---

## 前置條件

- 已登入；至少有一筆 **demand_fg**、**bom_edges** 資料；已上傳 **po_open_lines**（必填）、**inventory_snapshots**、**fg_financials**（選填，用於 PaR）。

---

## Step 1：跑第一次 BOM Explosion，取得 Run A

1. 進入 **Planning → Forecasts**。
2. 輸入 Plant ID（或留空）、Time Buckets（如 `2026-W06,2026-W07,2026-W08`），點 **Run BOM Explosion**。
3. 等待完成，記下成功訊息中的 component 筆數。
4. **預期**：列表出現一筆新批次；可選該批次看 **Results** / **Trace**。此時會產生一筆 **forecast_run**（Run A）。

---

## Step 2：跑第二次 BOM Explosion，取得 Run B（可調參數以產生差異）

1. 仍在 **Forecasts** 頁。
2. 可修改 Time Buckets（例如多加一週或改 plant），再次 **Run BOM Explosion**。
3. **預期**：再產生一筆新批次與一個新的 **forecast_run**（Run B）。兩個 run_id 不同。

---

## Step 3：進入 Risk Dashboard，確認預設為 Latest Run

1. 進入 **Risk**（Supply Coverage Risk 頁）。
2. 看頁面標題下方與 **Forecast Run** 下拉選單。
3. **預期**：下拉選單為「Latest run」或已選最近一筆 run；副標題出現「Risk based on Forecast Run: baseline (xxxxxxxx…)」。

---

## Step 4：切換 Forecast Run，觀察 Risk 結果差異

1. 在 **Forecast Run** 下拉選單改選 **Run A**（第一次跑的），等資料重新載入。
2. 記下某幾筆料號的 **Days to stockout**、**Profit at Risk**（或狀態 Critical/Warning 數量）。
3. 再改選 **Run B**（第二次跑的）。
4. **預期**：至少某料號／某工廠的 **Days to stockout** 或 **PaR** 或 **狀態** 與 Step 4.2 不同（因兩次 Run 的 component_demand 不同，導致日均需求或覆蓋不同）。

---

## Step 5：點進 Details，確認 Days to stockout / P(stockout) 有值

1. 在 Risk 表格中點選一筆有 **Days to stockout** 數字（非「—」）的列。
2. 打開右側 **Details Panel**。
3. **預期**：Details 中顯示 **Days to stockout**（天數）、**Shortage date**（若有）、**Stockout probability**（%）；並有說明「Days to stockout / P(stockout) from Inventory domain (component_demand)」。

---

## Step 6：從 Risk 追溯到該 Run 的 Trace（FG → Component）

1. 記下目前 Risk 頁面顯示的 **Forecast Run**（id 或 scenario_name）。
2. 前往 **Data → Import History**（或 **Planning → Forecasts**），找到對應該 run 的 **BOM Explosion 批次**（可依時間或 metadata 中的 forecast_run_id 對應）。
3. 點該批次，切到 **Trace** tab。
4. **預期**：可看到 FG → Component 的展開明細，與 Risk 使用的 component_demand 來源一致（同一 forecast_run_id）。

---

## Step 7：選「Latest run」且無任何 BOM Explosion 時（或 Run 無 component_demand）

1. 若環境中沒有任何 forecast run：**Forecast Run** 下拉選單僅「Latest run」，無其他選項。
2. **預期**：副標題可顯示「No forecast run (supply coverage only)」或類似；Risk 仍可載入（以 PO + Inventory 為主）；**Days to stockout** 欄位顯示「—」；說明文字為「請選擇 Forecast Run 以顯示（需先執行 BOM Explosion）」。

---

## Step 8：選了一個 Run 但該 Run 無 component_demand 資料

1. 若某 run 因故沒有 component_demand 資料（例如跑失敗或已清檔），在 Risk 選該 run。
2. **預期**：不應 crash；藍色說明區顯示「該 Forecast Run 無 component_demand 資料，無法計算（請確認已執行 BOM Explosion 並選對 Run）」；表格 **Days to stockout** 為「—」；其他 Supply Coverage、PaR 仍正常顯示。

---

## 檢查清單（快速對照）

| # | 項目 | 通過 |
|---|------|------|
| 1 | 跑兩次 Forecast 得到兩個 run_id | ☐ |
| 2 | Risk 可切換 run_id，結果有可觀差異 | ☐ |
| 3 | 點進 Details 能看到 Days to stockout / P(stockout) | ☐ |
| 4 | 可從 Risk 追溯到該 Run 的 Trace（Forecasts/Import History） | ☐ |
| 5 | 無 component_demand（或無 Run）時有清楚空態/錯誤提示 | ☐ |
