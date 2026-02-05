# 新增上傳模板說明文件

## 概述

本專案在 `templates/` 目錄中新增了 3 種上傳模板，每種模板提供 xlsx 和 csv 兩種格式，共 6 個檔案。

## 📁 新增檔案清單

### 1. Open PO Lines（採購訂單未交貨明細）
- `templates/po_open_lines.xlsx`
- `templates/po_open_lines.csv`

### 2. Inventory Snapshots（庫存快照）
- `templates/inventory_snapshots.xlsx`
- `templates/inventory_snapshots.csv`

### 3. FG Financials（成品財務資料）
- `templates/fg_financials.xlsx`
- `templates/fg_financials.csv`

---

## 📋 模板欄位規格

### A) po_open_lines（Open PO / Supply Commitments）

**用途：** 追蹤採購訂單未交貨數量，用於供應鏈計畫

#### 必填欄位
| 欄位名稱 | 資料型別 | 說明 | 範例 |
|---------|---------|------|------|
| `po_number` | text | 採購訂單號碼 | PO-10001 |
| `po_line` | text | 訂單行號 | 10, 20 |
| `material_code` | text | 物料代碼 | COMP-3100, RM-9000 |
| `plant_id` | text | 工廠代碼 | PLANT-01 |
| `time_bucket` | text | 時間區間（週或日期） | 2026-W05 或 2026-02-10 |
| `open_qty` | number | 未交貨數量 (≥ 0) | 5000 |

#### 選填欄位
| 欄位名稱 | 資料型別 | 預設值 | 說明 |
|---------|---------|--------|------|
| `uom` | text | pcs | 計量單位 |
| `supplier_id` | text | - | 供應商代碼 |
| `status` | text | - | 狀態（open/closed/cancelled） |
| `notes` | text | - | 備註 |

#### 範例資料（6 筆）
- 包含 5 張採購單（PO-10001 至 PO-10005）
- 涵蓋零件（COMP-系列）和原料（RM-系列）
- 支援週別（2026-W05）和日期（2026-02-10）兩種時間格式
- 包含 open 和 cancelled 狀態範例

---

### B) inventory_snapshots（Inventory Snapshot）

**用途：** 記錄特定時間點的庫存狀態，用於庫存管理和計畫

#### 必填欄位
| 欄位名稱 | 資料型別 | 說明 | 範例 |
|---------|---------|------|------|
| `material_code` | text | 物料代碼 | COMP-3100, FG-2000 |
| `plant_id` | text | 工廠代碼 | PLANT-01 |
| `snapshot_date` | date | 快照日期 (YYYY-MM-DD) | 2026-01-31 |
| `onhand_qty` | number | 在庫數量 (≥ 0) | 15000 |

#### 選填欄位
| 欄位名稱 | 資料型別 | 預設值 | 說明 |
|---------|---------|--------|------|
| `allocated_qty` | number | 0 | 已分配數量 (≥ 0) |
| `safety_stock` | number | 0 | 安全庫存 (≥ 0) |
| `uom` | text | pcs | 計量單位 |
| `notes` | text | - | 備註 |

#### 範例資料（6 筆）
- 涵蓋零件（COMP-系列）、原料（RM-系列）和成品（FG-系列）
- 所有資料為 2026-01-31 月底快照
- 包含庫存分配和安全庫存資訊
- 展示不同物料類型的庫存管理策略

---

### C) fg_financials（FG Margin / Price Rules）

**用途：** 定義成品的財務資訊，包含售價、利潤、有效期間

#### 必填欄位
| 欄位名稱 | 資料型別 | 說明 | 範例 |
|---------|---------|------|------|
| `material_code` | text | 成品代碼（FG） | FG-2000 |
| `unit_margin` | number | 單位利潤 (≥ 0) | 25.50 |

#### 選填欄位
| 欄位名稱 | 資料型別 | 預設值 | 說明 |
|---------|---------|--------|------|
| `plant_id` | text | - | 工廠代碼（空值代表通用） |
| `unit_price` | number | - | 單位售價 (≥ 0) |
| `currency` | text | USD | 幣別 |
| `valid_from` | date | - | 有效起始日 (YYYY-MM-DD) |
| `valid_to` | date | - | 有效結束日 (YYYY-MM-DD) |
| `notes` | text | - | 備註 |

#### 範例資料（6 筆）
- 涵蓋 6 個成品（FG-2000 至 FG-2500）
- 包含不同工廠的定價策略
- 展示全球通用定價（plant_id 為空）
- 包含促銷定價和多幣別範例（USD、EUR）
- 設定有效期間範例

---

## 🔧 檔案格式規範

### Excel (.xlsx)
- 第一列為欄位標題（header）
- 無合併儲存格
- 欄位寬度自動設定為 18 字元
- Sheet 名稱與檔案名稱相同（去除副檔名）

### CSV (.csv)
- UTF-8 編碼
- 逗號分隔
- 第一列為欄位標題
- 數值欄位不含引號（文字欄位自動加引號）

---

## 📊 資料命名規範（ERP Style）

本模板遵循真實 ERP 系統的命名慣例：

| 類別 | 格式 | 範例 |
|-----|------|------|
| 採購單 | PO-##### | PO-10001, PO-10002 |
| 採購單行號 | ## | 10, 20, 30 |
| 零件代碼 | COMP-#### | COMP-3100, COMP-3200 |
| 原料代碼 | RM-#### | RM-9000, RM-9100 |
| 成品代碼 | FG-#### | FG-2000, FG-2100 |
| 工廠代碼 | PLANT-## | PLANT-01, PLANT-02 |
| 供應商代碼 | SUP-### | SUP-001, SUP-002 |
| 週別格式 | YYYY-W## | 2026-W05, 2026-W06 |
| 日期格式 | YYYY-MM-DD | 2026-01-31, 2026-02-10 |

---

## 🚀 使用方式

### 1. 下載模板
從 `templates/` 目錄選擇所需的模板格式（xlsx 或 csv）

### 2. 填寫資料
- 保留第一列欄位標題
- 依據欄位規格填寫資料
- 必填欄位不可空白
- 選填欄位可留空

### 3. 上傳至系統
透過 SmartOps 系統的資料上傳功能匯入檔案

---

## 🔄 重新產生模板

如需重新產生模板檔案，執行以下指令：

```bash
node scripts/generate_new_templates.js
```

此腳本會自動產生所有 6 個模板檔案到 `templates/` 目錄。

---

## 📝 更新紀錄

### 2026-01-31
- ✅ 新增 po_open_lines 模板（xlsx + csv）
- ✅ 新增 inventory_snapshots 模板（xlsx + csv）
- ✅ 新增 fg_financials 模板（xlsx + csv）
- ✅ 每個模板包含 5-6 筆真實感範例資料
- ✅ 創建產生腳本 `scripts/generate_new_templates.js`
- ✅ 創建本說明文件

---

## 💡 注意事項

1. **時間格式彈性：** `time_bucket` 欄位支援週別（YYYY-W##）或日期（YYYY-MM-DD）兩種格式
2. **數量驗證：** 所有數量欄位必須 ≥ 0
3. **日期格式：** 統一使用 YYYY-MM-DD 格式
4. **通用設定：** `plant_id` 為空代表適用所有工廠（如 fg_financials）
5. **編碼格式：** CSV 檔案使用 UTF-8 編碼，確保正確讀取中文備註

---

## 📧 技術支援

如有問題或需要客製化模板，請聯繫開發團隊。
