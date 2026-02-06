# Go-live Gate 回歸測試矩陣

本文件為 **SmartOps 上線前回歸測試** 的完整矩陣，涵蓋：10 種 Upload Type、One-shot、Strict/Best-effort、Error Report、權限與效能。  
**交付對象**：可直接交給非開發人員照步驟執行。

---

## 目錄

1. [測試環境與前置](#1-測試環境與前置)
2. [Upload Type 矩陣（每種 4 類案例）](#2-upload-type-矩陣每種-4-類案例)
3. [One-shot 匯入](#3-one-shot-匯入)
4. [Strict vs Best-effort](#4-strict-vs-best-effort)
5. [Error Report](#5-error-report)
6. [權限／RLS](#6-權限rls)
7. [效能（壓力測試）](#7-效能壓力測試)
8. [P0 覆蓋總表](#8-p0-覆蓋總表)

---

## 1. 測試環境與前置

### 1.1 環境

- 已部署 Supabase（含 RLS、Ingest RPC 若啟用）。
- 至少兩組測試帳號：**授權角色**（可寫入）、**非授權角色**（僅讀或無專案權限，依你們 RLS 設計）。
- 瀏覽器：Chrome 或 Edge 最新版。

### 1.2 測試資料來源

| 類型 | 來源 | 說明 |
|------|------|------|
| 有現成 template | `templates/*.csv`、`templates/*.xlsx` | bom_edge, demand_fg, fg_financials, inventory_snapshots, po_open_lines |
| 需自建或參考 | 見下方各測項 | goods_receipt, price_history, supplier_master（可參考 `test_data_examples/supplier_master_test_cases.md`） |
| 缺必填／同義字／重複 | 本文件內 CSV 範例或自改 template | 每測項會註明「測試資料來源」 |

### 1.3 必填欄位速查（用於造錯案）

- **goods_receipt**: supplier_name, material_code, actual_delivery_date, received_qty  
- **price_history**: supplier_name, material_code, order_date, unit_price  
- **supplier_master**: supplier_code, supplier_name  
- **bom_edge**: parent_material, child_material, qty_per  
- **demand_fg**: material_code, plant_id, demand_qty + (week_bucket 或 date 其一)  
- **po_open_lines**: po_number, po_line, material_code, plant_id, open_qty + (week_bucket 或 date 其一)  
- **inventory_snapshots**: material_code, plant_id, snapshot_date, onhand_qty  
- **fg_financials**: material_code, unit_margin  

---

## 2. Upload Type 矩陣（每種 4 類案例）

以下對 **9 種 Upload Type**（goods_receipt, price_history, supplier_master, bom_edge, demand_fg, po_open_lines, inventory_snapshots, fg_financials, quality_incident）各做 4 類測項。  
若 UI 未開放 **quality_incident**，可略過該行，其餘 8 種必測。

---

### 2.1 成功案例（每種 Type 一則）

| # | uploadType | 測試資料來源 | 步驟 | 預期結果 | 優先級 |
|---|------------|--------------|------|----------|--------|
| U1-1 | goods_receipt | 自建 CSV：supplier_name, material_code, actual_delivery_date, received_qty 皆有值，至少 3 筆 | 1. Data Upload → 選 Goods Receipt 2. 上傳 CSV 3. 對應欄位（若需）4. 驗證通過後儲存 | 成功訊息、筆數正確；Import History 可查到該批次 | **P0** |
| U1-2 | price_history | 自建 CSV：supplier_name, material_code, order_date, unit_price 皆有值，至少 3 筆 | 同上，選 Price History | 同上 | **P0** |
| U1-3 | supplier_master | `test_data_examples` 或自建：supplier_code, supplier_name 皆有值 | 選 Supplier Master → 上傳 → 儲存 | 成功；Suppliers 列表可見 | **P0** |
| U1-4 | bom_edge | `templates/bom_edge.csv` | 選 BOM Edge → 上傳 → 儲存 | 成功；BOM Data 頁可看到資料 | **P0** |
| U1-5 | demand_fg | `templates/demand_fg.csv` | 選 Demand FG → 上傳 → 儲存 | 成功；BOM Data → FG 需求 tab 可見 | **P0** |
| U1-6 | po_open_lines | `templates/po_open_lines.csv` | 選 PO Open Lines → 上傳 → 儲存 | 成功；Risk 或相關列表可見 | **P0** |
| U1-7 | inventory_snapshots | `templates/inventory_snapshots.csv` | 選 Inventory Snapshots → 上傳 → 儲存 | 成功 | **P0** |
| U1-8 | fg_financials | `templates/fg_financials.csv` | 選 FG Financials → 上傳 → 儲存 | 成功 | **P0** |
| U1-9 | quality_incident | 依 schema 自建必填欄位 CSV（若此 type 已上線） | 選 Quality Incident → 上傳 → 儲存 | 成功 | P1 |

---

### 2.2 缺必填案例（每種 Type 一則）

| # | uploadType | 測試資料來源 | 步驟 | 預期結果 | 優先級 |
|---|------------|--------------|------|----------|--------|
| U2-1 | goods_receipt | 同一檔案內：第 1 筆完整，第 2 筆缺 material_code，第 3 筆缺 actual_delivery_date | 上傳 → 進入驗證步驟 | 驗證結果：1 筆有效、2 筆錯誤；錯誤列表註明缺哪個必填 | **P0** |
| U2-2 | price_history | 第 1 筆完整，第 2 筆缺 unit_price | 同上 | 1 有效、1 錯誤；錯誤訊息含必填欄位名 | **P0** |
| U2-3 | supplier_master | 第 1 筆有 code+name，第 2 筆缺 supplier_name | 同上 | 1 有效、1 錯誤 | **P0** |
| U2-4 | bom_edge | 第 1 筆完整，第 2 筆缺 qty_per | 同上 | 1 有效、1 錯誤 | **P0** |
| U2-5 | demand_fg | 第 1 筆完整，第 2 筆缺 plant_id | 同上 | 1 有效、1 錯誤 | **P0** |
| U2-6 | po_open_lines | 第 1 筆完整，第 2 筆缺 open_qty 或 time 相關 | 同上 | 1 有效、1 錯誤 | **P0** |
| U2-7 | inventory_snapshots | 第 1 筆完整，第 2 筆缺 snapshot_date | 同上 | 1 有效、1 錯誤 | **P0** |
| U2-8 | fg_financials | 第 1 筆完整，第 2 筆缺 unit_margin | 同上 | 1 有效、1 錯誤 | **P0** |

---

### 2.3 欄位同義字／映射案例（每種 Type 一則）

| # | uploadType | 測試資料來源 | 步驟 | 預期結果 | 優先級 |
|---|------------|--------------|------|----------|--------|
| U3-1 | goods_receipt | CSV 表頭用「供應商名稱」「料號」「實際交貨日」「收貨數量」等中文 | 上傳後在 Mapping 將中文欄位對應到系統欄位（supplier_name, material_code, actual_delivery_date, received_qty） | 對應完成後驗證通過，儲存成功 | **P0** |
| U3-2 | price_history | 表頭用「訂單日期」「單價」等別名 | 手動對應 order_date, unit_price | 驗證通過、儲存成功 | **P0** |
| U3-3 | supplier_master | 表頭用「供應商代碼」「供應商名稱」 | 對應 supplier_code, supplier_name | 驗證通過、儲存成功 | **P0** |
| U3-4 | bom_edge | 表頭用「父件」「子件」「單位用量」 | 對應 parent_material, child_material, qty_per | 驗證通過、儲存成功 | **P0** |
| U3-5 | demand_fg | 表頭用「成品料號」「工廠」「需求數量」「週桶」 | 對應 material_code, plant_id, demand_qty, week_bucket | 驗證通過、儲存成功 | **P0** |
| U3-6 | po_open_lines | 表頭用「PO 單號」「行號」「物料」「工廠」「未交數量」「週」 | 對應 po_number, po_line, material_code, plant_id, open_qty, week_bucket | 驗證通過、儲存成功 | **P0** |
| U3-7 | inventory_snapshots | 表頭用「物料」「工廠」「快照日」「在庫量」 | 對應 material_code, plant_id, snapshot_date, onhand_qty | 驗證通過、儲存成功 | **P0** |
| U3-8 | fg_financials | 表頭用「成品代碼」「單位利潤」 | 對應 material_code, unit_margin | 驗證通過、儲存成功 | **P0** |

---

### 2.4 重複資料案例（每種 Type 一則）

| # | uploadType | 測試資料來源 | 步驟 | 預期結果 | 優先級 |
|---|------------|--------------|------|----------|--------|
| U4-1 | supplier_master | 同一 supplier_code 出現 2 筆（不同 supplier_name 或相同） | 上傳 → 驗證 → 儲存 | 依規格：合併為一筆或後筆覆蓋前筆；或顯示重複警告，不寫入重複 key；無 crash | **P0** |
| U4-2 | bom_edge | 同一 (parent_material, child_material, plant_id) 兩筆 | 上傳 → 儲存 | 依規格：upsert 或唯一約束處理；無 crash | **P0** |
| U4-3 | demand_fg | 同一 (material_code, plant_id, time_bucket) 兩筆 | 同上 | 依規格處理；無 crash | **P0** |
| U4-4 | po_open_lines | 同一 (po_number, po_line) 兩筆 | 同上 | 依規格處理；無 crash | **P0** |
| U4-5 | inventory_snapshots | 同一 (material_code, plant_id, snapshot_date) 兩筆 | 同上 | 依規格處理；無 crash | **P0** |
| U4-6 | fg_financials | 同一 material_code 兩筆（同 plant 或皆空） | 同上 | 依規格處理；無 crash | **P0** |
| U4-7 | goods_receipt / price_history | 多筆同 supplier + material，不同日期 | 上傳 → 儲存 | 全部寫入或依 idempotency 規則；無半套寫入 | **P0** |

---

## 3. One-shot 匯入

### 3.1 多 Sheet 正確分類與映射

| # | 測試資料來源 | 步驟 | 預期結果 | 優先級 |
|---|--------------|------|----------|--------|
| O1-1 | 自建 xlsx：Sheet1 為 supplier_master 欄位、Sheet2 為 bom_edge 欄位、Sheet3 為 demand_fg 欄位，每 sheet 至少 2 筆 | 1. 開啟 One-shot 2. 上傳 xlsx 3. 執行 AI 建議（或手動）為每個 sheet 選對 Upload Type 並完成 mapping 4. 全部啟用 5. 執行匯入 | 三個 sheet 皆分類正確、映射完整；匯入成功；Import History 可見多 sheet 結果 | **P0** |
| O1-2 | 使用 `templates/*.xlsx` 多檔合併成一個 xlsx（例如 bom_edge + demand_fg 各一 sheet） | 同上 | 每個 sheet 對應正確 type；匯入成功 | **P0** |

### 3.2 任一 Sheet 失敗時的處理（Best-effort vs All-or-nothing）

| # | 測試資料來源 | 步驟 | 預期結果 | 優先級 |
|---|--------------|------|----------|--------|
| O2-1 | xlsx：Sheet1 資料全對、Sheet2 故意缺必填（例如整欄空白） | Best-effort 模式 → 執行匯入 | Sheet1 成功寫入；Sheet2 失敗或 Needs Review；結果頁明確標示哪個 sheet 成功／失敗；**不因 Sheet2 失敗而回滾 Sheet1** | **P0** |
| O2-2 | 同上 | All-or-nothing 模式 → 執行匯入 | 若 Sheet2 失敗，**整次匯入視為失敗**；依實作可為：全部不寫入，或已寫入的 rollback；結果頁顯示失敗原因 | **P0** |
| O2-3 | 三個 sheet：1 成功、1 缺必填、1 成功 | Best-effort → 匯入 | 2 個成功、1 個失敗；報告中 Succeeded / Failed 數量正確 | **P0** |

---

## 4. Strict vs Best-effort

| # | 測試資料來源 | 步驟 | 預期結果 | 優先級 |
|---|--------------|------|----------|--------|
| S1 | 單檔：10 筆中 7 筆有效、3 筆缺必填 | 選 **Best-effort** → 上傳 → 驗證 → 儲存 | 可點擊儲存；僅 7 筆寫入；畫面上標示「Skip N error rows」或類似；無寫入 3 筆錯誤列 | **P0** |
| S2 | 同上（10 筆中 7 有效、3 無效） | 選 **Strict** → 上傳 → 驗證 | **儲存按鈕 disabled**；文案明確「Strict mode: Fix errors to enable save」或等同說明 | **P0** |
| S3 | 同上 | Strict 模式下修正 3 筆錯誤後再驗證 | 驗證通過後儲存按鈕可點；儲存後 10 筆皆寫入 | **P0** |
| S4 | 有錯誤列時 | 在驗證結果頁切換 Best-effort ↔ Strict | 切換後按鈕可點／不可點與文案隨之改變；可下載 Error Report（見下一節） | **P0** |

---

## 5. Error Report

| # | 測試資料來源 | 步驟 | 預期結果 | 優先級 |
|---|--------------|------|----------|--------|
| E1 | 單檔：第 2、5、7 筆有必填缺失或格式錯誤 | 上傳 → 驗證 → 點「Download Error Report (.csv)」 | 會下載一個 CSV 檔；檔名含 uploadType 與時間戳 | **P0** |
| E2 | 同上 | 開啟下載的 CSV | 欄位包含：**Row Index, Field, Original Value, Error Message, Full Row Data (JSON)**；至少上述欄位存在且可讀 | **P0** |
| E3 | 同上 | 對照 CSV 中 Row Index 與原始檔案 | **Row Index 對應原始檔案的列號**（例如表頭為第 1 列則資料從第 2 列起，Row Index 2 = 檔案第 2 列）；錯誤列之 Row Index 與實際錯誤列一致 | **P0** |
| E4 | 同一檔案 | 檢查 CSV 中 Error Message、Field | 錯誤訊息與畫面上顯示一致；Field 為系統欄位名或可辨識欄位標籤 | **P0** |
| E5 | One-shot 結果頁有失敗 sheet | 點「Download Report (JSON)」 | 下載 JSON；內容含各 sheet 的 status、savedCount、reason 等；失敗 sheet 有錯誤資訊 | P1 |

---

## 6. 權限／RLS

| # | 角色 | 步驟 | 預期結果 | 優先級 |
|---|------|------|----------|--------|
| R1 | **未登入（anon）** | 直接呼叫 Ingest RPC（例如 Postman 或 SQL Editor 以 anon key 呼叫） | **401 或 permission denied**；**不得寫入**任何業務表 | **P0** |
| R2 | **已登入（authenticated）** | 使用一般登入帳號執行任一 uploadType 上傳並儲存 | **可正常寫入**；Import History 可見該使用者自己的批次 | **P0** |
| R3 | **已登入** | 上傳後到對應資料頁（如 BOM Data、Suppliers）查詢 | 僅能看到**自己**的資料（同一 user_id）；看不到其他使用者的資料 | **P0** |
| R4 | **service_role（若專案有後端代寫）** | 以 service_role 呼叫 RPC 或直接 insert | 依設計：可寫入且可指定 user；若未開放則應拒絕 | P1 |

**說明**：R1 驗證 anon 無執行權；R2/R3 驗證 RLS 與授權角色可寫、資料隔離。

---

## 7. 效能（壓力測試）

| # | 測試資料來源 | 步驟 | 預期結果 | 優先級 |
|---|--------------|------|----------|--------|
| P1 | **5,000～20,000 筆** 的單一 uploadType CSV（例如 demand_fg 或 bom_edge，可複製 template 多行或腳本產生） | 1. 選定 uploadType 2. 上傳該大檔 3. 完成 mapping（若需）4. 驗證通過後儲存 5. **記錄：從點擊儲存到成功訊息出現的時間** | 在合理時間內完成（建議單次 < 2 分鐘，或依你們 SLA）；**不超時、不崩潰**；成功筆數與檔案有效筆數一致；若有 chunk 上傳，進度或訊息可辨識 | **P0** |
| P2 | 同上（可較小，如 1,000 筆） | goods_receipt 或 price_history 使用 RPC 路徑 | 若已部署 Ingest RPC：以 RPC 完成寫入；無 500/超時 | P1 |

**備註**：壓力測試資料可放在 `templates/` 下如 `demand_fg_10k.csv`，或由腳本依 `templates/demand_fg.csv` 格式產生。

---

## 8. P0 覆蓋總表

以下為 **P0 必測** 的最小集合，確保 Go-live 前皆已執行並通過。

| 類別 | 測項編號 | 一句話描述 |
|------|----------|------------|
| Upload 成功 | U1-1～U1-8 | 每種 uploadType 至少一筆成功上傳並可查 |
| Upload 缺必填 | U2-1～U2-8 | 每種 type 缺必填時驗證報錯、錯誤列數正確 |
| Upload 同義字 | U3-1～U3-8 | 每種 type 可透過欄位映射正確寫入 |
| Upload 重複 | U4-1～U4-7 | 重複 key 時不 crash、行為符合規格 |
| One-shot | O1-1, O1-2, O2-1, O2-2, O2-3 | 多 sheet 分類／映射正確；Best-effort 與 All-or-nothing 差異明確 |
| Strict/Best-effort | S1, S2, S3, S4 | Best-effort 可存有效列；Strict 有錯時不可存；切換與文案正確 |
| Error Report | E1, E2, E3, E4 | 可下載、欄位正確、Row # 對得上原始資料 |
| 權限 | R1, R2, R3 | 非授權不寫入、授權可寫入、RLS 隔離 |
| 效能 | P1 | 5k～20k 筆單次上傳不超時、可量測時間 |

---

## 附錄 A：快速造錯案 CSV 範例（缺必填）

**goods_receipt_missing.csv**（第 2 筆缺 material_code，第 3 筆缺 actual_delivery_date）：

```csv
supplier_name,material_code,actual_delivery_date,received_qty
Supplier A,MAT-001,2026-02-01,100
Supplier B,,2026-02-02,200
Supplier C,MAT-003,,300
```

**supplier_master_missing.csv**（第 2 筆缺 supplier_name）：

```csv
supplier_code,supplier_name
SUP001,Company A
SUP002,
SUP003,Company C
```

其餘 type 可依「必填欄位速查」自行刪除某一欄或留空一列製造錯誤列。

---

## 附錄 B：測試執行記錄建議

執行時建議記錄：

- 測項編號、執行日期、執行人  
- 結果：Pass / Fail  
- 若 Fail：簡述現象（例如「Error report 的 Row Index 從 0 開始而非 1」）  
- 效能 P1：實際耗時（秒）與筆數  

可另建一表或試算表對應本矩陣，方便追蹤 Go-live 簽核。
