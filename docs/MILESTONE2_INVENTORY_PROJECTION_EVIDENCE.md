# 里程碑 2：Inventory Projection Engine — 證據包

## 證據 A：測試輸出（投影引擎 tests 綠燈）

**指令：** `npx vitest run src/domains/inventory/inventoryProjection.test.js`

**完整輸出：**

```
 RUN  v4.0.18 C:/Users/a8594/smartops-app

 ✓ src/domains/inventory/inventoryProjection.test.js (8 tests) 3ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  21:47:25
   Duration  135ms (transform 21ms, setup 0ms, import 29ms, tests 3ms, environment 0ms)
```

- **檔案：** `src/domains/inventory/inventoryProjection.test.js`
- **結果：** 8 passed（投影引擎單元測試全數通過）

---

## 證據 B：Inventory Tab Demo（可手算驗證）

以下用「同一個 run 下、任選一列 material+plant、Details 一個 bucket」示範手算。

### 選定 Run
- **Run：** `baseline`（或 Run ID 前 8 碼例如 `a1b2c3d4`）  
  （實際操作時請貼你畫面上的 run 名稱或 id 前 8 碼）

### 任選一列 material + plant
- **Material：** `A`  
- **Plant：** `P1`  
  （即 key `A|P1`，實際可為你畫面上任一行）

### Details 中「一個 bucket」的數字（來自逐 bucket 表）

| 欄位     | 數值 |
|----------|------|
| time_bucket | 2026-W06 |
| begin_on_hand | 100 |
| inbound  | 50  |
| demand   | 20  |
| end_on_hand | 130 |

### 手算驗證
**公式：** `end = begin + inbound − demand`

**代入：**  
130 = 100 + 50 − 20  
130 = 130 ✓  

結論：該 bucket 的 `end_on_hand` 與公式一致。

---

### 若你實際在 UI 操作時

1. 在 Forecasts 頁選一個 Run（記下名稱或 id 前 8 碼）。
2. 切到 **Inventory** tab，等 KPI 與 Summary 載入。
3. 在 Summary 任點一列（material + plant）。
4. 在 Details 表格中任選一列（一個 time_bucket），抄下該行的 **begin / inbound / demand / end**。
5. 手算：`end = begin + inbound − demand`，確認相等後，把上述「選定 Run、該列 material+plant、該 bucket 四個數字、手算一句」貼到本文件「證據 B」區塊即可。
