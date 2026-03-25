# Week 1 教材：從零開始學寫程式

> **對象：** 完全不會寫 code 的你
> **目標：** 4 天後你能讀懂專案裡的 `calculator.js`，並且自己從零寫出一個類似的模組
> **工具：** 你只需要一個瀏覽器和 VS Code（或任何文字編輯器）

---

## Day 1：JavaScript 基礎 — 變數、函式、條件判斷

### 1.1 什麼是程式？

程式就是一份「給電腦看的食譜」。你告訴電腦一步一步要做什麼，它照做。

打開你的終端機（Terminal），輸入 `node` 進入 JavaScript 互動模式。跟著打：

```javascript
// 這是一行註解，電腦會忽略它。// 後面的文字是給人看的。
```

### 1.2 變數 — 幫資料取名字

變數就是一個「名牌」，你把一個資料貼上名牌，之後就可以用名字找到它。

```javascript
// 用 const 宣告一個「不會改變」的變數
const myName = 'Louis';
const age = 22;
const isStudent = true;

// 用 let 宣告一個「可能會改」的變數
let score = 85;
score = 90; // 可以改

// 印出來看看
console.log(myName);    // 印出: Louis
console.log(age);       // 印出: 22
console.log(score);     // 印出: 90
```

**三種基本資料型別：**

| 型別 | 例子 | 說明 |
|------|------|------|
| `string` 字串 | `'hello'`、`"世界"` | 用引號包起來的文字 |
| `number` 數字 | `42`、`3.14`、`-5` | 整數或小數 |
| `boolean` 布林 | `true`、`false` | 只有兩個值：是 / 否 |

**練習 1：** 在 Terminal 裡宣告三個變數：你的名字、你的年齡、你是不是學生。然後用 `console.log` 印出來。

---

### 1.3 函式 — 可以重複使用的食譜

函式就是一段「打包好的程式碼」，你給它一些材料（參數），它做完事情後把結果還給你（回傳值）。

```javascript
// 定義一個函式：計算兩個數字的加總
function add(a, b) {
  return a + b;
}

// 使用這個函式
const result = add(3, 5);
console.log(result); // 印出: 8

// 你可以重複使用它
console.log(add(10, 20)); // 印出: 30
console.log(add(1, 1));   // 印出: 2
```

拆解一下：
- `function` — 告訴電腦「我要定義一個函式」
- `add` — 函式的名字
- `(a, b)` — 參數（材料），呼叫時傳進來的值
- `return a + b` — 回傳值（做出來的菜）
- `add(3, 5)` — 呼叫函式，把 3 和 5 傳進去

**另一種寫法（箭頭函式）：**

```javascript
// 跟上面的 add 完全一樣，只是寫法不同
const add = (a, b) => {
  return a + b;
};

// 如果只有一行 return，可以更簡短
const add = (a, b) => a + b;
```

**練習 2：** 寫一個函式 `multiply(a, b)`，回傳兩個數字的乘積。測試 `multiply(4, 5)` 應該得到 20。

---

### 1.4 條件判斷 — 讓程式做決定

```javascript
function checkTemperature(temp) {
  if (temp > 37.5) {
    return '發燒了！';
  } else if (temp > 36) {
    return '體溫正常';
  } else {
    return '體溫偏低';
  }
}

console.log(checkTemperature(38));   // 印出: 發燒了！
console.log(checkTemperature(36.5)); // 印出: 體溫正常
console.log(checkTemperature(35));   // 印出: 體溫偏低
```

拆解：
- `if (條件)` — 如果條件成立（true），就執行大括號裡的程式碼
- `else if (另一個條件)` — 否則，如果這個條件成立
- `else` — 以上都不成立時

**比較運算子：**

| 符號 | 意思 | 例子 |
|------|------|------|
| `>` | 大於 | `5 > 3` → true |
| `<` | 小於 | `5 < 3` → false |
| `>=` | 大於等於 | `5 >= 5` → true |
| `<=` | 小於等於 | `4 <= 5` → true |
| `===` | 等於 | `5 === 5` → true |
| `!==` | 不等於 | `5 !== 3` → true |

**練習 3：** 寫一個函式 `gradeScore(score)`，根據分數回傳等級：
- 90 以上 → `'A'`
- 80 以上 → `'B'`
- 70 以上 → `'C'`
- 60 以上 → `'D'`
- 60 以下 → `'F'`

---

### 1.5 物件 — 把相關資料打包在一起

```javascript
// 一個學生的資料
const student = {
  name: 'Louis',
  age: 22,
  score: 85
};

// 取出資料
console.log(student.name);  // 印出: Louis
console.log(student.score); // 印出: 85

// 函式可以接收物件
function introduce(person) {
  return `我叫 ${person.name}，今年 ${person.age} 歲`;
}

console.log(introduce(student)); // 印出: 我叫 Louis，今年 22 歲
```

**解構賦值 — 從物件中取出欄位的簡寫：**

```javascript
// 完整寫法
const name = student.name;
const age = student.age;

// 解構寫法（效果完全一樣，只是更簡潔）
const { name, age } = student;
```

**練習 4：** 建立一個物件代表一個產品：
```javascript
const product = { name: '螺絲', stock: 100, dailyUsage: 15, price: 2.5 };
```
寫一個函式 `daysUntilEmpty(product)`，計算這個產品幾天後會用完（stock / dailyUsage）。

---

### 1.6 陣列 — 一堆資料的清單

```javascript
const fruits = ['蘋果', '香蕉', '橘子'];

// 取第一個（從 0 開始算！）
console.log(fruits[0]); // 印出: 蘋果
console.log(fruits[1]); // 印出: 香蕉

// 陣列長度
console.log(fruits.length); // 印出: 3

// 用 for 迴圈走過每一個
for (const fruit of fruits) {
  console.log(fruit);
}
// 依序印出: 蘋果、香蕉、橘子
```

**練習 5：** 建立一個陣列包含 5 個數字，寫一個函式 `sum(numbers)` 計算所有數字的加總。

```javascript
function sum(numbers) {
  let total = 0;
  for (const num of numbers) {
    total = total + num;
  }
  return total;
}

console.log(sum([1, 2, 3, 4, 5])); // 應該印出: 15
```

---

### Day 1 總結

你今天學會了：
- **變數** — `const` / `let` 存放資料
- **函式** — `function name(參數) { return 結果; }` 打包邏輯
- **條件判斷** — `if / else if / else` 讓程式做決定
- **物件** — `{ key: value }` 打包相關資料
- **陣列** — `[item1, item2, ...]` 存放一堆資料
- **迴圈** — `for (const item of array)` 走過每一筆

這六個概念就是整個 `calculator.js` 用到的全部基礎。沒有更多了。

---

## Day 2：讀懂你專案裡的 calculator.js

現在你有了基礎，來讀真正的程式碼。

打開 `src/domains/inventory/calculator.js`。

### 2.1 常數定義 — 第 19–46 行

```javascript
export const RISK_THRESHOLDS = {
  CRITICAL_DAYS: 7,
  WARNING_DAYS: 14,
  HIGH_VOLATILITY: 0.2,
  URGENCY_CRITICAL: 100,
  URGENCY_WARNING: 50,
  URGENCY_LOW: 10,
  MAX_PROBABILITY: 0.95,
  STATUS_CRITICAL: 'critical',
  STATUS_WARNING: 'warning',
  STATUS_OK: 'ok',
  STATUS_LOW: 'low'
};
```

**這是什麼？** 一個物件，裡面存放所有的「門檻值」。

**為什麼要這樣做？** 假設你的老闆說「把緊急的標準從 7 天改成 5 天」，你只需要改 `CRITICAL_DAYS: 5` 這一個地方，整個程式就會跟著改。如果你把 `7` 直接寫在程式碼裡面（硬編碼），你得找遍整個檔案所有出現 `7` 的地方去改——很容易漏改。

**`export` 是什麼？** 表示「允許其他檔案引入這個東西」。就像餐廳菜單上有的菜才能點，`export` 的東西才能被其他檔案使用。

**新概念 — 工廠函式（Factory Function）：**

```javascript
export const ERROR_MESSAGES = {
  INVALID_NUMBER: (name) => `${name} must be a valid number`,
  NEGATIVE_NUMBER: (name) => `${name} cannot be negative`,
};
```

`INVALID_NUMBER` 不是一個固定的字串，而是一個**函式**。你呼叫它的時候傳一個名字進去：

```javascript
ERROR_MESSAGES.INVALID_NUMBER('currentStock')
// 回傳: "currentStock must be a valid number"

ERROR_MESSAGES.INVALID_NUMBER('dailyDemand')
// 回傳: "dailyDemand must be a valid number"
```

這樣一個模板就能產生各種不同的錯誤訊息，不用寫很多份。

---

### 2.2 第一個函式 — calculateDaysToStockout（第 72–126 行）

這個函式計算「庫存還能撐幾天」。讓我們一段一段讀：

**函式簽名：**

```javascript
export function calculateDaysToStockout(currentStock, dailyDemand, safetyStock = 0) {
```

- `currentStock` — 現在有多少庫存
- `dailyDemand` — 每天用掉多少
- `safetyStock = 0` — 安全庫存（預設值是 0，如果呼叫時沒傳就用 0）

**輸入驗證（第 74–82 行）：**

```javascript
if (typeof currentStock !== 'number' || isNaN(currentStock)) {
  throw new Error(ERROR_MESSAGES.INVALID_NUMBER('currentStock'));
}
```

逐字翻譯：
- `typeof currentStock !== 'number'` → 如果 currentStock 的型別不是數字
- `||` → 或者
- `isNaN(currentStock)` → currentStock 是 NaN（Not a Number，一種特殊的「壞掉的數字」）
- `throw new Error(...)` → 丟出一個錯誤，程式會中斷

**為什麼要做輸入驗證？** 如果有人不小心傳了一個字串 `"abc"` 進來，沒有驗證的話 `"abc" / 10` 會得到 `NaN`，程式不會報錯但結果是錯的。有驗證的話會直接告訴你「hey，你傳了一個不是數字的東西進來」。

**邊界情況處理（第 84–106 行）：**

```javascript
// 負庫存 = 已經沒貨了
if (currentStock < 0) {
  return { days: 0, status: 'critical' };
}

// 庫存低於安全水位 = 已經警戒了
if (currentStock < safetyStock) {
  return { days: 0, status: 'critical' };
}

// 沒人在用 = 永遠不會斷
if (dailyDemand <= 0) {
  return { days: Infinity, status: 'ok' };
}
```

**什麼是邊界情況（Edge Case）？** 就是那些「不尋常但有可能發生」的情況。新手寫程式最常犯的錯就是只處理「正常情況」，忘了處理「奇怪的輸入」。

想像你在寫一個除法函式 `divide(a, b)`。正常情況是 `divide(10, 2) = 5`，但如果有人呼叫 `divide(10, 0)` 呢？除以零在數學上是未定義的。如果你沒處理這個邊界情況，程式會回傳 `Infinity`，然後後面的計算全部壞掉。

**核心計算（第 108–125 行）：**

```javascript
const availableStock = currentStock - safetyStock;
const days = availableStock / dailyDemand;

let status;
if (days < RISK_THRESHOLDS.CRITICAL_DAYS) {     // < 7 天
  status = RISK_THRESHOLDS.STATUS_CRITICAL;       // 'critical'
} else if (days < RISK_THRESHOLDS.WARNING_DAYS) { // < 14 天
  status = RISK_THRESHOLDS.STATUS_WARNING;         // 'warning'
} else {
  status = RISK_THRESHOLDS.STATUS_OK;              // 'ok'
}

return { days: Math.max(0, days), status };
```

這就是你在 Day 1 學過的所有東西的組合：變數、除法、if/else、物件。

`Math.max(0, days)` 的意思是「取 0 和 days 中比較大的那個」，確保天數不會是負數。

---

### 2.3 第二個函式 — calculateStockoutProbability（第 154–188 行）

這個函式用「啟發式規則」估算斷料機率。

**什麼是啟發式（Heuristic）？** 不是精確的數學公式，而是基於經驗的「大概估算」。就像你看天空烏雲密布，你「估計」等下會下雨——這就是啟發式。

```javascript
// 庫存只夠用不到一半的補貨時間 → 很危險 → 90%
if (daysToStockout < leadTimeDays * 0.5) {
  baseProbability = 0.9;
}
// 庫存不夠撐到補貨到 → 有風險 → 70%
else if (daysToStockout < leadTimeDays) {
  baseProbability = 0.7;
}
// 庫存勉強夠 → 有點風險 → 30%
else if (daysToStockout < leadTimeDays * 1.5) {
  baseProbability = 0.3;
}
// 庫存充足 → 低風險 → 10%
else {
  baseProbability = 0.1;
}
```

然後，如果需求波動很大（`demandVolatility > 0.2`），機率再加 10%，但上限是 95%：

```javascript
const volatilityAdjustment = demandVolatility > 0.2 ? 0.1 : 0;

const probability = Math.min(
  baseProbability + volatilityAdjustment,
  0.95  // 上限 95%
);
```

**新語法 — 三元運算子：**

```javascript
// 這一行
const x = condition ? valueIfTrue : valueIfFalse;

// 等同於
let x;
if (condition) {
  x = valueIfTrue;
} else {
  x = valueIfFalse;
}
```

---

### 2.4 組合函式 — calculateInventoryRisk（第 255–298 行）

這個函式把前面三個函式「串起來」：

```javascript
export function calculateInventoryRisk(position) {
  // 從物件中取出需要的欄位
  const { currentStock, safetyStock = 0, dailyDemand, leadTimeDays, demandVolatility = 0.1 } = position;

  // 第一步：算斷料天數
  const stockoutResult = calculateDaysToStockout(currentStock, dailyDemand, safetyStock);

  // 第二步：算斷料機率
  const probability = calculateStockoutProbability(stockoutResult.days, leadTimeDays, demandVolatility);

  // 第三步：算緊迫分數
  const urgencyScore = calculateUrgencyScore(stockoutResult.days);

  // 第四步：決定風險等級
  let riskLevel;
  if (urgencyScore === 100) riskLevel = 'critical';
  else if (urgencyScore === 50) riskLevel = 'warning';
  else riskLevel = 'low';

  // 打包成一個物件回傳
  return { daysToStockout: stockoutResult.days, probability, urgencyScore, riskLevel };
}
```

**這就是「函式組合」（Function Composition）。** 每個小函式只做一件事，最後有一個大函式把它們串起來。好處是：
- 每個小函式都可以單獨測試
- 如果斷料機率的算法要改，只改 `calculateStockoutProbability`，不影響其他部分
- 讀起來像自然語言：「先算天數，再算機率，再算緊迫度，最後決定等級」

---

### 2.5 什麼是「純函式」（Pure Function）？

檔案開頭寫了「所有函數都是 Pure Functions」。意思是：

**規則 1：相同的輸入，永遠得到相同的輸出。**

```javascript
calculateDaysToStockout(100, 10, 20) // 永遠回傳 { days: 8, status: 'critical' }
calculateDaysToStockout(100, 10, 20) // 還是 { days: 8, status: 'critical' }
// 不管你呼叫幾次，結果都一樣
```

**規則 2：不修改外面的東西，也不依賴外面會變的東西。**

```javascript
// 這不是純函式（依賴外部狀態）
let taxRate = 0.05;
function calculateTax(price) {
  return price * taxRate; // taxRate 是外面的變數，可能被別人改掉
}

// 這是純函式（所有需要的東西都從參數傳進來）
function calculateTax(price, taxRate) {
  return price * taxRate;
}
```

**為什麼純函式重要？**
- 好測試：不需要準備任何環境，直接給 input 檢查 output
- 好理解：看函式簽名就知道它需要什麼、回傳什麼
- 不怕副作用：不會因為呼叫一個函式而意外改了別的東西

---

## Day 3：自己動手寫 — 從零實作 Calculator

### 3.1 作業說明

現在你要自己寫一個庫存計算器。不要看原始碼，用你自己的理解去寫。

在專案根目錄建立檔案 `my-practice/calculator.js`：

```bash
mkdir -p my-practice
touch my-practice/calculator.js
```

### 3.2 第一關：寫常數

```javascript
// my-practice/calculator.js

// 先定義你的門檻值
const THRESHOLDS = {
  CRITICAL_DAYS: 7,
  WARNING_DAYS: 14,
};

// 你的第一個任務：補完這個物件
// 需要什麼常數？想想看上面學到的...
```

### 3.3 第二關：寫 calculateDaysToStockout

```javascript
function calculateDaysToStockout(currentStock, dailyDemand, safetyStock) {
  // TODO: 你的程式碼寫在這裡
  //
  // 提示（按照順序思考）：
  // 1. 先處理參數預設值：safetyStock 沒傳的話用 0
  // 2. 輸入驗證：三個參數都必須是數字
  // 3. 邊界情況：負庫存？庫存低於安全水位？零需求？
  // 4. 正常計算：(currentStock - safetyStock) / dailyDemand
  // 5. 判斷狀態：幾天對應什麼風險等級？
  // 6. 回傳結果：{ days: ???, status: '???' }
}
```

### 3.4 第三關：寫測試

在 `my-practice/calculator.test.js` 中寫測試。不需要任何測試框架，直接用 `console.log` 和 `assert`：

```javascript
// my-practice/calculator.test.js
import { calculateDaysToStockout } from './calculator.js';

// 測試工具：簡易版 assert
function assertEqual(actual, expected, testName) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (pass) {
    console.log(`✅ ${testName}`);
  } else {
    console.log(`❌ ${testName}`);
    console.log(`   期望: ${JSON.stringify(expected)}`);
    console.log(`   實際: ${JSON.stringify(actual)}`);
  }
}

// 測試 1: 正常情況
assertEqual(
  calculateDaysToStockout(100, 10, 20),
  { days: 8, status: 'critical' },
  '庫存100, 日需求10, 安全庫存20 → 8天, critical'
);

// 測試 2: 零需求
assertEqual(
  calculateDaysToStockout(100, 0, 0),
  { days: Infinity, status: 'ok' },
  '零需求 → 無限天'
);

// 測試 3: 負庫存
assertEqual(
  calculateDaysToStockout(-5, 10, 0),
  { days: 0, status: 'critical' },
  '負庫存 → 0天, critical'
);

// 測試 4: 庫存充足
assertEqual(
  calculateDaysToStockout(200, 10, 0),
  { days: 20, status: 'ok' },
  '庫存200, 日需求10 → 20天, ok'
);

// 測試 5: 傳入非數字 → 應該報錯
try {
  calculateDaysToStockout('abc', 10, 0);
  console.log('❌ 傳入字串應該報錯，但沒有');
} catch (error) {
  console.log('✅ 傳入字串正確報錯:', error.message);
}

// 你的任務：再加 3 個你想到的測試案例
// 測試 6: ???
// 測試 7: ???
// 測試 8: ???
```

執行測試：

```bash
node my-practice/calculator.test.js
```

### 3.5 第四關：加一個新函式

在你的 `calculator.js` 中加入一個原始碼**沒有**的新函式：

```javascript
/**
 * 計算最佳補貨數量（EOQ - Economic Order Quantity）
 *
 * 公式：EOQ = sqrt(2 × annualDemand × orderCost / holdingCostPerUnit)
 *
 * 白話解釋：
 * - annualDemand：一年總共需要多少個
 * - orderCost：每次下訂單的固定成本（不管買多少，下一次單都要花這麼多）
 * - holdingCostPerUnit：每個東西放在倉庫一年的成本
 *
 * 買太少 → 訂單成本高（常常要下單）
 * 買太多 → 倉儲成本高（倉庫放不下）
 * EOQ 就是找到「剛剛好」的數量
 *
 * @param {number} annualDemand - 年需求量
 * @param {number} orderCost - 每次訂購成本
 * @param {number} holdingCostPerUnit - 每單位年持有成本
 * @returns {number} 最佳訂購數量
 */
function calculateEOQ(annualDemand, orderCost, holdingCostPerUnit) {
  // TODO：你來實作
  //
  // 提示：
  // 1. 輸入驗證（三個參數都要是正數）
  // 2. 公式用到 Math.sqrt()（開根號）
  // 3. 回傳值用 Math.round()（四捨五入成整數）
}
```

---

## Day 4：讀懂 BOM Calculator + 遞迴

### 4.1 什麼是 BOM？

BOM = Bill of Materials = 物料清單。

想像你要做一台腳踏車：
```
腳踏車 (1台)
├── 車架 (1個)
│   ├── 鋼管 (3根)
│   └── 焊接件 (6個)
├── 前輪 (1個)
│   ├── 輪圈 (1個)
│   ├── 輪胎 (1個)
│   └── 輪軸 (1個)
└── 後輪 (1個)
    ├── 輪圈 (1個)
    ├── 輪胎 (1個)
    ├── 輪軸 (1個)
    └── 齒輪組 (1個)
        ├── 大齒輪 (1個)
        └── 小齒輪 (3個)
```

**BOM Explosion（物料展開）** 就是把這棵樹「攤平」，算出每個零件總共需要多少：
- 鋼管：3 根
- 輪圈：2 個（前輪 1 + 後輪 1）
- 輪胎：2 個
- 小齒輪：3 個
- ...

### 4.2 什麼是遞迴？

遞迴 = 函式呼叫自己。

先看一個簡單的例子——計算階乘（5! = 5 × 4 × 3 × 2 × 1 = 120）：

```javascript
function factorial(n) {
  // 終止條件（Base Case）— 遞迴一定要有終止條件，否則無限迴圈！
  if (n <= 1) {
    return 1;
  }
  // 遞迴步驟 — 把問題縮小
  return n * factorial(n - 1);
}

console.log(factorial(5)); // 120
```

呼叫過程：
```
factorial(5)
= 5 × factorial(4)
= 5 × 4 × factorial(3)
= 5 × 4 × 3 × factorial(2)
= 5 × 4 × 3 × 2 × factorial(1)
= 5 × 4 × 3 × 2 × 1
= 120
```

**BOM 展開也是遞迴。** 「腳踏車需要什麼零件？」→ 先看第一層（車架、前輪、後輪）→ 對每個子件再問「它需要什麼零件？」→ 繼續往下展開，直到沒有子件為止。

### 4.3 動手寫簡化版 BOM Explosion

```javascript
// my-practice/bom.js

/**
 * BOM 資料結構
 * 每筆資料表示：parent 需要 qtyPer 個 child
 */
const bomTable = [
  { parent: '腳踏車', child: '車架',   qtyPer: 1 },
  { parent: '腳踏車', child: '前輪',   qtyPer: 1 },
  { parent: '腳踏車', child: '後輪',   qtyPer: 1 },
  { parent: '車架',   child: '鋼管',   qtyPer: 3 },
  { parent: '車架',   child: '焊接件', qtyPer: 6 },
  { parent: '前輪',   child: '輪圈',   qtyPer: 1 },
  { parent: '前輪',   child: '輪胎',   qtyPer: 1 },
  { parent: '後輪',   child: '輪圈',   qtyPer: 1 },
  { parent: '後輪',   child: '輪胎',   qtyPer: 1 },
  { parent: '後輪',   child: '齒輪組', qtyPer: 1 },
  { parent: '齒輪組', child: '大齒輪', qtyPer: 1 },
  { parent: '齒輪組', child: '小齒輪', qtyPer: 3 },
];

/**
 * 找出某個父件的所有子件
 * @param {string} parent - 父件名稱
 * @returns {Array} 子件清單
 */
function getChildren(parent) {
  return bomTable.filter(row => row.parent === parent);
}

/**
 * 遞迴展開 BOM
 *
 * @param {string} item - 要展開的品項
 * @param {number} qty - 需求數量
 * @param {number} depth - 目前深度（防止無限遞迴）
 * @param {Set} visited - 已走訪的品項（偵測循環）
 * @returns {Map<string, number>} 零件名稱 → 總需求量
 */
function explode(item, qty, depth = 0, visited = new Set()) {
  const result = new Map();

  // TODO 1: 檢查深度，超過 10 層就停止
  // if (depth > 10) { ... }

  // TODO 2: 檢查循環引用
  // if (visited.has(item)) { ... }

  // TODO 3: 找出子件
  // const children = getChildren(item);

  // TODO 4: 如果沒有子件 → 這是最底層零件，記錄需求量
  // if (children.length === 0) {
  //   result.set(item, qty);
  //   return result;
  // }

  // TODO 5: 對每個子件遞迴展開
  // for (const child of children) {
  //   const childQty = qty * child.qtyPer;
  //   const childResult = explode(child.child, childQty, depth + 1, new Set([...visited, item]));
  //
  //   // 把子件的結果合併到總結果中
  //   for (const [key, value] of childResult) {
  //     result.set(key, (result.get(key) || 0) + value);
  //   }
  // }

  return result;
}

// 測試：展開 1 台腳踏車需要的所有零件
const requirements = explode('腳踏車', 1);
console.log('=== 1 台腳踏車需要的零件 ===');
for (const [part, qty] of requirements) {
  console.log(`${part}: ${qty} 個`);
}

// 預期結果：
// 鋼管: 3 個
// 焊接件: 6 個
// 輪圈: 2 個（前輪 1 + 後輪 1）
// 輪胎: 2 個
// 大齒輪: 1 個
// 小齒輪: 3 個
```

### 4.4 進階挑戰：加入報廢率

在真實工廠裡，生產過程會有損耗。如果報廢率是 5%，你想得到 100 個零件，實際需要生產 `100 / (1 - 0.05) ≈ 105.26` 個。

修改 bomTable 加入報廢率，然後修改 `explode` 函式把報廢率納入計算：

```javascript
const bomTableWithScrap = [
  { parent: '腳踏車', child: '車架',   qtyPer: 1, scrapRate: 0.02 },
  { parent: '腳踏車', child: '前輪',   qtyPer: 1, scrapRate: 0.01 },
  // ...
];

// 修改後的需求量計算：
// childQty = qty * child.qtyPer * (1 + child.scrapRate)
```

### 4.5 對照你的專案的 bomCalculator.js

現在回頭看 `src/domains/forecast/bomCalculator.js`，你會發現它做的事跟你寫的一樣，只是多了：

1. **更完整的驗證** — 每個參數都驗證型別和範圍
2. **良率（yield_rate）** — 除了報廢率，還考慮良率。公式：`qty * qtyPer * (1 + scrapRate) / yieldRate`
3. **時間維度** — 不只是「需要幾個」，還要考慮「什麼時候需要」（time_bucket）
4. **工廠維度** — 同一個零件在不同工廠有不同的 BOM
5. **追溯記錄** — 記錄每個零件的展開路徑，方便事後查詢「這個需求是怎麼算出來的」

---

## Day 4 作業清單

完成以下項目，你就完成了 Week 1：

- [ ] **calculator.js** — 自己寫完 `calculateDaysToStockout`，不看原始碼
- [ ] **calculator.js** — 自己寫完 `calculateStockoutProbability`
- [ ] **calculator.js** — 自己寫完 `calculateInventoryRisk`（組合前兩個函式）
- [ ] **calculator.js** — 自己寫完 `calculateEOQ`（新函式，原始碼裡沒有的）
- [ ] **calculator.test.js** — 至少 10 個測試案例全部通過
- [ ] **bom.js** — 自己寫完 `explode` 函式，正確展開腳踏車 BOM
- [ ] **bom.js** — 加入報廢率計算
- [ ] **bom.js** — 加入循環偵測（建一筆 `{ parent: 'A', child: 'B' }` 和 `{ parent: 'B', child: 'A' }` 的假資料，確認你的程式不會當掉）

跑你的測試：
```bash
node my-practice/calculator.test.js
node my-practice/bom.js
```

---

## 附錄 A：常用 JavaScript 語法速查表

```javascript
// 變數
const x = 10;         // 不會改的值
let y = 20;           // 會改的值

// 函式
function add(a, b) { return a + b; }
const add = (a, b) => a + b;         // 箭頭函式

// 條件
if (x > 10) { } else if (x > 5) { } else { }
const result = x > 10 ? '大' : '小';  // 三元運算子

// 物件
const obj = { name: 'Louis', age: 22 };
const { name, age } = obj;            // 解構
obj.name;                              // 取值

// 陣列
const arr = [1, 2, 3];
arr[0];                                // 取第一個 → 1
arr.length;                            // 長度 → 3
arr.push(4);                           // 加到最後 → [1, 2, 3, 4]
arr.filter(x => x > 2);               // 過濾 → [3, 4]
arr.map(x => x * 2);                  // 轉換 → [2, 4, 6, 8]

// 迴圈
for (const item of arr) { console.log(item); }
for (let i = 0; i < arr.length; i++) { console.log(arr[i]); }

// Map（進階字典）
const map = new Map();
map.set('key', 'value');
map.get('key');            // → 'value'
map.has('key');            // → true

// Set（不重複集合）
const set = new Set();
set.add('a');
set.add('a');              // 重複，不會加
set.has('a');              // → true
set.size;                  // → 1

// 錯誤處理
try {
  throw new Error('出錯了');
} catch (error) {
  console.log(error.message); // → '出錯了'
}

// typeof 檢查型別
typeof 42;         // → 'number'
typeof 'hello';    // → 'string'
typeof true;       // → 'boolean'
typeof undefined;  // → 'undefined'

// 特殊值
NaN;               // Not a Number（壞掉的數字）
Infinity;          // 無限大
null;              // 刻意設定的「空」
undefined;         // 沒有被賦值的變數

// Math 常用方法
Math.max(3, 5);        // → 5
Math.min(3, 5);        // → 3
Math.round(3.6);       // → 4（四捨五入）
Math.floor(3.9);       // → 3（無條件捨去）
Math.ceil(3.1);        // → 4（無條件進位）
Math.sqrt(16);         // → 4（開根號）
Math.pow(2, 3);        // → 8（2 的 3 次方）
isNaN(NaN);            // → true
isNaN(42);             // → false
```

## 附錄 B：常見錯誤與解決方法

| 錯誤訊息 | 原因 | 解決方法 |
|----------|------|---------|
| `ReferenceError: x is not defined` | 用了一個沒宣告的變數 | 確認有 `const x = ...` 或 `let x = ...` |
| `TypeError: x is not a function` | 你以為 x 是函式但它不是 | 檢查 x 的值和型別 |
| `SyntaxError: Unexpected token` | 語法寫錯（漏了括號、分號等） | 仔細檢查該行附近的括號和符號 |
| `Maximum call stack size exceeded` | 遞迴沒有終止條件 | 確認有 base case |
| `NaN` 出現在結果裡 | 某個計算用到了非數字的值 | 用 `console.log` 印出中間值，找出哪裡變成 NaN |
