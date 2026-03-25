# Round 6 修改指南 — 四個問題 + 為什麼 Round 5 沒修到

---

## 先回答：Round 5 指南寫了，為什麼這些問題還在？

### 診斷表

| 本次問題 | Round 5 有寫嗎？ | 為什麼沒修到？ |
|---------|----------------|--------------|
| ① K/M/B 被當矛盾（98.7 vs 98,666） | ❌ **沒寫** | Round 5 B1 修的是 `detectMagnitudeMismatches` 的 PCT_COL regex（百分比欄位誤匹配）。但這次的問題出在 `collectContradictoryClaims` — 完全不同的函數。B1 根本不涉及矛盾偵測。 |
| ② Magnitude mismatch 比錯（SUM vs 單月 MAX） | ⚠️ **部分相關** | Round 5 B1 加了 PCT_COL 跳過百分比欄位。但這次的 bug 是 `detectMagnitudeMismatches` 把敘述的全月份 SUM（13.59M）跟 SQL 結果的「單行最大值」（1.19M）比。B1 沒改比較邏輯本身，只改了欄位過濾。 |
| ③ Time Period pill 顯示 "2,016" | ❌ **從未識別** | 5 輪修改都沒發現 `formatPillValue` 會把 "2016-09 to 2018-09" 錯誤解析成數字 2016。這是一個全新的 bug。 |
| ④ 浮點殘留（1010271.3700000371） | ✅ **有寫（A3）** | Round 5 有 cleanFloatingPointInText 的修法，但**你還沒實施**。函數已經存在（line 442），只是 normalizeBrief 沒有對所有欄位調用它。 |

### 根本原因

Round 5 的核心假設是「magnitude mismatch 和 K/M/B 格式化是同一個問題」。
實際上它們是**三個不同函數裡的三個不同 bug**：

```
detectMagnitudeMismatches()  ← Round 5 B1 修了 PCT_COL（✅），但比較邏輯沒修（❌）
collectContradictoryClaims() ← Round 5 完全沒動（❌）
formatPillValue()            ← Round 5 完全沒動（❌）
```

---

## Fix 1：`collectContradictoryClaims` — K/M/B 格式化被當矛盾

### 問題

```
Conflicting count orders values detected: 98.7 (brief_metric_pills) vs 98,666 (artifact_metrics)
Conflicting mean revenue values detected: 543.67 (brief_metric_pills) vs 543,666 (artifact_metrics)
```

**根因**：`collectMetricFacts`（line 1060-1064）從 metric_pill 提取數值時，用 `parseNumericValue` 解析。
Pill value `"98,666"` 解析為 `98666`。但 pill value `"R$543.67K"` 也經過 `parseNumericValue`：

```javascript
// parseNumericValue (line 967-984)
const match = raw.match(/-?\d[\d,.]*/);  // "R$543.67K" → match = "543.67"
// 結果：543.67 — K 後綴被忽略
```

然後 artifact_metrics 裡的 `543666` 和 pill 的 `543.67` 進入 `areNumbersMeaningfullyDifferent`：
```javascript
// areNumbersMeaningfullyDifferent (line 1144-1149)
const delta = Math.abs(543.67 - 543666);  // = 543122.33
const scale = Math.max(1, 543.67, 543666); // = 543666
return 543122.33 > Math.max(0.5, 543666 * 0.02); // 543122 > 10873 → TRUE → 標記為矛盾
```

**問題本質**：`parseNumericValue` 不理解 K/M/B 後綴。`543.67K` 被解析為 `543.67` 而非 `543670`。

### 修法

**檔案**：`src/services/agentResponsePresentationService.js`
**函數**：`parseNumericValue`
**行號**：967-984

```javascript
// ❌ 現狀
function parseNumericValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/-?\d[\d,.]*/);
  if (!match) return null;
  // ... (comma handling) ...
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

// ✅ 改為：識別 K/M/B 後綴並還原真實值
function parseNumericValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  // 先嘗試提取帶 K/M/B 後綴的數字
  const kmb = raw.match(/([-+]?\d[\d,.]*)\s*([KMBkmb])\b/);
  if (kmb) {
    let num = parseFloat(kmb[1].replace(/,/g, ''));
    if (!Number.isFinite(num)) return null;
    const suffix = kmb[2].toUpperCase();
    if (suffix === 'K') num *= 1_000;
    else if (suffix === 'M') num *= 1_000_000;
    else if (suffix === 'B') num *= 1_000_000_000;
    return num;
  }

  const match = raw.match(/-?\d[\d,.]*/);
  if (!match) return null;

  let normalized = match[0];
  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.replace(/,/g, '');
  } else if (normalized.includes(',') && !normalized.includes('.')) {
    const pieces = normalized.split(',');
    normalized = pieces.length > 1 && pieces[pieces.length - 1].length <= 2
      ? `${pieces.slice(0, -1).join('')}.${pieces[pieces.length - 1]}`
      : normalized.replace(/,/g, '');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
```

### 驗證

修完後：
- `parseNumericValue("R$543.67K")` → `543670`（不再是 543.67）
- `parseNumericValue("98,666")` → `98666`
- `areNumbersMeaningfullyDifferent(543670, 543666)` → `false`（差 4，遠小於 2% threshold）
- `areNumbersMeaningfullyDifferent(98700, 98666)` → `false`（差 34，遠小於 2%）
- → 矛盾不再被觸發 ✅

---

## Fix 2：`detectMagnitudeMismatches` — SUM vs 單行 MAX 比錯

### 問題

```
Magnitude mismatch: Narrative cites 13,591,644 but SQL column "payment_value" max is 1,194,882.8 — possible 11x inflation
```

**根因**：`detectMagnitudeMismatches`（line 1330-1452）的比較邏輯：

```javascript
// Line 1388-1396：建立 column range
const nums = [...valueSet];
columnRanges.set(col, {
  max: Math.max(...nums),    // ← 這裡取的是「所有行裡 payment_value 的最大值」= 單月最高 1,194,882
  min: Math.min(...nums.filter(v => v > 0)),
  values: nums,
});

// Line 1439：比較
if (briefNum > range.max * upperTolerance && range.max > minThreshold) {
  // 13,591,644 > 1,194,882 * 3 = 3,584,646 → TRUE → 標記為 mismatch
}
```

敘述引用的 `13,591,644` 是 **SUM(payment_value) across all months**。
但 `range.max` 是 **MAX of individual row values** = 單月最高值 1,194,882。
兩者差 11 倍是正常的（有 24 個月的數據），不是 inflation。

**問題本質**：函數只收集了 per-row 值，沒有計算 column-level aggregates（SUM、AVG）。
當 Agent 在敘述中引用 SUM 時，跟 per-row MAX 比較永遠會 mismatch。

### 修法

**檔案**：`src/services/agentResponsePresentationService.js`
**函數**：`detectMagnitudeMismatches`
**行號**：1381-1397，在 columnRanges 建立時加入 SUM

```javascript
// ❌ 現狀 (line 1381-1397)
const columnRanges = new Map();
for (const [col, valueSet] of sqlValues) {
  if (PCT_COL.test(col)) continue;
  const isMonetary = MONETARY_COL.test(col);
  const isCount = COUNT_COL.test(col);
  if (!isMonetary && !isCount) continue;
  const nums = [...valueSet];
  columnRanges.set(col, {
    isMonetary,
    isCount,
    isAvg: AVG_COL.test(col),
    max: Math.max(...nums),
    min: Math.min(...nums.filter(v => v > 0)),
    values: nums,
  });
}

// ✅ 改為：加入 sum，讓 narrative 的總計值也能匹配
const columnRanges = new Map();
for (const [col, valueSet] of sqlValues) {
  if (PCT_COL.test(col)) continue;
  const isMonetary = MONETARY_COL.test(col);
  const isCount = COUNT_COL.test(col);
  if (!isMonetary && !isCount) continue;
  const nums = [...valueSet];
  const sum = nums.reduce((a, b) => a + b, 0);
  columnRanges.set(col, {
    isMonetary,
    isCount,
    isAvg: AVG_COL.test(col),
    max: Math.max(...nums),
    min: Math.min(...nums.filter(v => v > 0)),
    sum,                          // ← 新增
    count: nums.length,           // ← 新增
    values: nums,
  });
}
```

然後修改 exact match 檢查（line 1404-1412），同時比對 per-row 值和 aggregate 值：

```javascript
// ❌ 現狀 (line 1404-1412)
let foundExactMatch = false;
for (const [, range] of columnRanges) {
  if (range.values.some(v => Math.abs(v - briefNum) / Math.max(Math.abs(v), 1) < 0.01)) {
    foundExactMatch = true;
    break;
  }
}

// ✅ 改為：也跟 SUM 和 AVG 比較
let foundExactMatch = false;
for (const [, range] of columnRanges) {
  // 比對 per-row 值
  if (range.values.some(v => Math.abs(v - briefNum) / Math.max(Math.abs(v), 1) < 0.01)) {
    foundExactMatch = true;
    break;
  }
  // 比對 SUM（narrative 經常引用跨行總計）
  if (range.sum > 0 && Math.abs(range.sum - briefNum) / Math.max(range.sum, 1) < 0.01) {
    foundExactMatch = true;
    break;
  }
  // 比對 AVG（narrative 經常引用平均值）
  if (range.count > 1) {
    const avg = range.sum / range.count;
    if (avg > 0 && Math.abs(avg - briefNum) / Math.max(avg, 1) < 0.05) {
      foundExactMatch = true;
      break;
    }
  }
}
```

### 驗證

修完後：
- `payment_value` column：per-row values 範圍 145 ~ 1,194,882，**sum = ~15,800,000**
- Narrative 引用 `13,591,644`（order_items.price 的 SUM，不是 payment_value）
- `revenue` column：per-row values 範圍 267 ~ 1,010,271，**sum = ~13,591,644**
- `Math.abs(13591644 - 13591644) / 13591644 < 0.01` → **TRUE → exact match → 不再 mismatch** ✅

---

## Fix 3：`formatPillValue` — "2016-09 to 2018-09" 被格式化成 "2,016"

### 問題

Metric pill "Time Period" 的 value 是 `"2016-09 to 2018-09"`，
但顯示為 `"2,016"`。

**根因**：`formatPillValue`（line 423-435）：

```javascript
const str = String(raw ?? '').trim();          // "2016-09 to 2018-09"
if (/[KMB%]$/i.test(str)) return str;          // 不匹配
const num = parseFloat(str.replace(/,/g, '')); // parseFloat("2016-09 to 2018-09") = 2016
if (!Number.isFinite(num)) return str;          // 2016 IS finite → 不 return
const abs = Math.abs(num);                      // 2016
if (abs >= 100) return num.toLocaleString('en-US', { maximumFractionDigits: 0 }); // → "2,016"
```

`parseFloat("2016-09 to 2018-09")` 成功解析前面的 `2016`，後面的 `-09 to 2018-09` 被忽略。

### 修法

**檔案**：`src/services/agentResponsePresentationService.js`
**函數**：`formatPillValue`
**行號**：423-435

```javascript
// ❌ 現狀
function formatPillValue(raw) {
  const str = String(raw ?? '').trim();
  if (/[KMB%]$/i.test(str)) return str;
  const num = parseFloat(str.replace(/,/g, ''));
  if (!Number.isFinite(num)) return str;
  // ... formatting ...
}

// ✅ 改為：加入非數字內容的 early return
function formatPillValue(raw) {
  const str = String(raw ?? '').trim();
  // Already formatted (has K/M/B suffix or % sign) — pass through
  if (/[KMB%]$/i.test(str)) return str;
  // Non-numeric content: contains letters (except currency symbols), date patterns,
  // or connectors like "to", "~", "–" — pass through as-is
  if (/[a-wyz]/i.test(str) || /\d{4}-\d{2}/.test(str) || /\bto\b|[~–—]/i.test(str)) return str;
  const num = parseFloat(str.replace(/,/g, ''));
  if (!Number.isFinite(num)) return str;
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(num / 1_000).toFixed(1)}K`;
  if (abs >= 100) return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return str;
}
```

### 正則解釋

```javascript
/[a-wyz]/i.test(str)     // 包含非 x 的字母（x 出現在 "1.5x"，需要保留格式化）
/\d{4}-\d{2}/.test(str)  // 包含日期 pattern（2016-09）
/\bto\b|[~–—]/i.test(str)  // 包含範圍連接詞
```

### 驗證

- `formatPillValue("2016-09 to 2018-09")` → `"2016-09 to 2018-09"` ✅ （`\d{4}-\d{2}` 匹配）
- `formatPillValue("R$13.59M")` → `"R$13.59M"` ✅ （`[KMB%]$` 匹配）
- `formatPillValue("98666")` → `"98.7K"` ✅ （正常格式化）
- `formatPillValue("543666")` → `"543.7K"` ✅ （正常格式化）
- `formatPillValue("1.5x growth")` → `"1.5x growth"` ✅ （`[a-wyz]` 匹配 "growth"）
- `formatPillValue("24")` → `"24"` ✅ （數字 < 100，保持原樣）

---

## Fix 4：`normalizeBrief` — 浮點殘留未清理

### 問題

敘述和表格到處是 `R$1,010,271.3700000371`、`854686.3300000255`、`49507.66000000016`。

**根因**：`cleanFloatingPointInText` 函數已經存在（line 442），但 `normalizeBrief` 只對 `metric_pills` 調用了 `formatPillValue`，沒有對其他欄位調用 `cleanFloatingPointInText`。

### 修法

**檔案**：`src/services/agentResponsePresentationService.js`
**函數**：`normalizeBrief`

找到 `normalizeBrief` 函數（搜尋 `function normalizeBrief`），在函數末尾、return 之前加入全域清理：

```javascript
// 在 normalizeBrief 的 return brief 之前加入：

// ── Clean floating point residuals across all text fields ──
const textFields = ['headline', 'executive_summary', 'summary', 'methodology_note'];
for (const field of textFields) {
  if (typeof brief[field] === 'string') {
    brief[field] = cleanFloatingPointInText(brief[field]);
  }
}
const arrayFields = ['key_findings', 'implications', 'caveats', 'next_steps'];
for (const field of arrayFields) {
  if (Array.isArray(brief[field])) {
    brief[field] = brief[field].map(item =>
      typeof item === 'string' ? cleanFloatingPointInText(item) : item
    );
  }
}
// Clean table cell values
if (Array.isArray(brief.tables)) {
  for (const table of brief.tables) {
    if (Array.isArray(table.rows)) {
      table.rows = table.rows.map(row =>
        Array.isArray(row)
          ? row.map(cell => typeof cell === 'string' ? cleanFloatingPointInText(cell) : cell)
          : row
      );
    }
  }
}
```

### 驗證

- `"R$1,010,271.3700000371"` → `"R$1,010,271.37"` ✅
- `"854686.3300000255"` → `"854686.33"` ✅
- `"49507.66000000016"` → `"49507.66"` ✅

---

## 執行順序

```
1. Fix 3 (formatPillValue)        — 1 分鐘，加 1 行 if
2. Fix 1 (parseNumericValue)      — 5 分鐘，加 K/M/B 解析
3. Fix 2 (detectMagnitudeMismatches) — 5 分鐘，加 SUM/AVG 比對
4. Fix 4 (normalizeBrief float)   — 3 分鐘，加清理 loop
```

改完後跑一次同樣的查詢，預期：
- correctness 從 0.0 升到 8+（三個假陽性全部消除）
- Time Period pill 正確顯示 "2016-09 to 2018-09"
- 敘述裡不再有 15 位小數的浮點殘留
- 總 QA score 從 6.0 升到 8.0+

---

## 附：與之前文件的關係

| 文件 | 狀態 | 說明 |
|------|------|------|
| DI-Pipeline-Round5-Fix-Guide.md | 部分過時 | B1 (PCT_COL) 仍然有效但不夠。B2 (CAP_DELTA) 已被你實作。A1/A2 的 prompt 改動仍有效。A3 被本指南 Fix 4 取代。 |
| DI-Enforce-ModelConfig-Provider-Guide.md | 仍然有效 | 修 Claude prefill 400 錯誤，跟本指南獨立。 |
| DI-Next-Level-Architecture-Guide.md | 長期規劃 | Evidence-First 架構，等止血完成後再做。 |
| DI-Task-Mode-Implementation-Plan.md | 長期規劃 | Task Mode，等品質穩定後再做。 |
| **本指南 (Round 6)** | **立即執行** | 修 4 個當前問題，30 分鐘內可完成。 |
