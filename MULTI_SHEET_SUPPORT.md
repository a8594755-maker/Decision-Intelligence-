# Excel 多 Sheet 支援功能

## 問題診斷

### 原始問題

使用者上傳包含多個 sheet 的 Excel 檔案（如 Sheet1, Sheet2），但系統**只讀取第一個 sheet**，導致：

- ❌ 讀取到錯誤的 sheet 資料
- ❌ AI 映射失敗（資料不符合預期）
- ❌ 日期格式錯誤（可能第一個 sheet 是空的或格式不對）
- ❌ 驗證失敗（資料結構不正確）

### 根本原因

在 `handleFileChange` 函數中，系統固定讀取第一個 sheet：

```javascript
// 舊程式碼（問題所在）
const wsname = wb.SheetNames[0];  // ← 固定讀取第一個 sheet
const data = XLSX.utils.sheet_to_json(wb.Sheets[wsname], { defval: '' });
```

如果使用者的資料在 Sheet2，但系統讀取 Sheet1，就會出現各種錯誤。

---

## ✅ 完成的修復

### 修復 1：儲存整個 Workbook

新增 state 來儲存完整的 workbook 和 sheet 資訊：

```javascript
// 新增的 states
const [workbook, setWorkbook] = useState(null);       // 儲存整個 workbook
const [sheetNames, setSheetNames] = useState([]);     // 所有 sheet 名稱
const [selectedSheet, setSelectedSheet] = useState(''); // 當前選擇的 sheet
```

### 修復 2：讀取所有 Sheets

修改檔案上傳邏輯，讀取所有 sheet 資訊：

```javascript
const { workbookData, rows, cols, sheets, defaultSheet } = await new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = (evt) => {
    const bstr = evt.target.result;
    const wb = XLSX.read(bstr, { type: 'binary' });
    
    // 取得所有 sheet 名稱
    const sheets = wb.SheetNames;
    
    // 預設使用第一個 sheet
    const defaultSheet = sheets[0];
    const data = XLSX.utils.sheet_to_json(wb.Sheets[defaultSheet], { defval: '' });
    
    resolve({
      workbookData: wb,      // ← 儲存完整 workbook
      rows: data,
      cols: Object.keys(data[0]),
      sheets: sheets,        // ← 所有 sheet 名稱
      defaultSheet: defaultSheet
    });
  };
  reader.readAsBinaryString(selectedFile);
});

// 儲存到 state
setWorkbook(workbookData);
setSheetNames(sheets);
setSelectedSheet(defaultSheet);
```

### 修復 3：Sheet 切換功能

新增 `handleSheetChange` 函數，允許使用者切換 sheet：

```javascript
const handleSheetChange = (sheetName) => {
  if (!workbook) return;
  
  try {
    setLoading(true);
    
    // 從選擇的 sheet 讀取資料
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    
    if (data.length === 0) {
      addNotification(`Sheet "${sheetName}" is empty`, "error");
      return;
    }
    
    const cols = Object.keys(data[0]);
    
    // 更新 state
    setSelectedSheet(sheetName);
    setRawRows(data);
    setColumns(cols);
    
    // 重置映射（因為欄位可能不同）
    setColumnMapping({});
    setMappingComplete(false);
    setValidationResult(null);
    
    addNotification(`Switched to sheet "${sheetName}", loaded ${data.length} rows`, "success");
    setLoading(false);
  } catch (error) {
    addNotification(`Failed to load sheet "${sheetName}": ${error.message}`, "error");
    setLoading(false);
  }
};
```

### 修復 4：UI Sheet 選擇器

在 Step 3（欄位映射）頁面頂部添加 sheet 選擇器：

```jsx
{/* Sheet Selector (if multiple sheets available) */}
{sheetNames.length > 1 && (
  <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <FileSpreadsheet className="w-5 h-5 text-yellow-600" />
        <span className="font-medium text-yellow-900 dark:text-yellow-100">
          Multiple sheets detected:
        </span>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-sm text-yellow-800 dark:text-yellow-200">
          Select sheet:
        </label>
        <select
          value={selectedSheet}
          onChange={(e) => handleSheetChange(e.target.value)}
          disabled={loading}
          className="px-3 py-1.5 rounded border bg-white text-sm"
        >
          {sheetNames.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>
    </div>
    <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-2">
      Currently showing data from sheet: <strong>{selectedSheet}</strong> ({rawRows.length} rows)
    </p>
  </div>
)}
```

**顯示條件**：
- ✅ 只在有多個 sheet 時顯示
- ✅ 突出顯示（黃色背景）
- ✅ 即時切換，無需重新上傳

---

## 🎯 使用流程

### 情境 1：單一 Sheet Excel

```
上傳 Excel（只有 Sheet1）
   ↓
系統讀取 Sheet1
   ↓
顯示：「Loaded X rows」
   ↓
不顯示 sheet 選擇器（只有一個 sheet）
   ↓
繼續正常流程（映射 → 驗證 → 儲存）
```

**UI 外觀**：
- 沒有黃色提示框
- 直接進入欄位映射

### 情境 2：多個 Sheets Excel

```
上傳 Excel（有 Sheet1, Sheet2, Sheet3）
   ↓
系統讀取 Sheet1（預設）
   ↓
顯示：「Loaded X rows (Sheet: Sheet1, 3 sheets available)」
   ↓
顯示黃色 sheet 選擇器
   ↓
使用者選擇「Sheet2」
   ↓
系統載入 Sheet2 資料
   ↓
重置欄位映射（因為欄位可能不同）
   ↓
繼續正常流程
```

**UI 外觀**：

```
┌─────────────────────────────────────────────────────────┐
│ 📋 Multiple sheets detected:        Select sheet: [▼]  │
│                                                         │
│ Currently showing data from sheet: Sheet2 (150 rows)   │
└─────────────────────────────────────────────────────────┘
```

---

## 📊 實際範例

### 範例 1：Price History 在 Sheet2

**Excel 結構**：
```
工作簿: Price_Data.xlsx
  ├─ Sheet1 (空白或其他資料)
  ├─ Sheet2 (Price History) ← 您的資料在這裡！
  └─ Sheet3 (筆記)
```

**舊流程（會失敗）**：
```
上傳 Excel
   ↓
系統讀取 Sheet1 (空白)
   ↓
❌ 錯誤：「File is empty」
或
❌ 讀取到錯誤的資料
   ↓
AI 映射失敗
   ↓
使用者困惑 😵
```

**新流程（會成功）**：
```
上傳 Excel
   ↓
系統讀取 Sheet1 (預設)
   ↓
顯示：「Loaded X rows (3 sheets available)」
   ↓
使用者看到黃色提示框 💡
   ↓
選擇「Sheet2」
   ↓
✅ 系統載入正確的資料
   ↓
AI 映射成功！
   ↓
完成 🎉
```

### 範例 2：Goods Receipt 在 Sheet1

**Excel 結構**：
```
工作簿: GR_Data.xlsx
  ├─ Sheet1 (Goods Receipt) ← 資料在第一個 sheet
  └─ Sheet2 (備份)
```

**流程**：
```
上傳 Excel
   ↓
系統讀取 Sheet1（正確）
   ↓
顯示：「Loaded X rows (2 sheets available)」
   ↓
顯示黃色選擇器，但預設已經是 Sheet1 ✅
   ↓
使用者可以繼續，或切換到 Sheet2 查看
   ↓
完成
```

---

## 🔍 功能特性

### 自動檢測

- ✅ 自動檢測 Excel 中有多少個 sheets
- ✅ 預設載入第一個 sheet
- ✅ 只在多個 sheets 時顯示選擇器

### 即時切換

- ✅ 無需重新上傳 Excel
- ✅ 即時載入新 sheet 的資料
- ✅ 自動重置欄位映射（因為欄位可能不同）

### 智能提示

- ✅ 顯示當前 sheet 名稱
- ✅ 顯示當前 sheet 的資料行數
- ✅ 顯示總共有多少個 sheets

### 錯誤處理

- ✅ 如果選擇的 sheet 是空的，顯示錯誤
- ✅ 如果切換失敗，保持原有 sheet
- ✅ 詳細的錯誤訊息

---

## 📝 通知訊息

### 上傳成功（單一 Sheet）

```
✅ Loaded 150 rows
```

### 上傳成功（多個 Sheets）

```
✅ Loaded 150 rows (Sheet: Sheet1, 3 sheets available)
```

### 切換 Sheet 成功

```
✅ Switched to sheet "Sheet2", loaded 200 rows
```

### 切換 Sheet 失敗（空白）

```
❌ Sheet "Sheet3" is empty
```

### 切換 Sheet 失敗（錯誤）

```
❌ Failed to load sheet "Sheet4": [錯誤詳情]
```

---

## 🎨 UI 設計

### Sheet 選擇器外觀

**顏色方案**：
- 背景：黃色淺色 (`bg-yellow-50`)
- 邊框：黃色 (`border-yellow-200`)
- 圖示：黃色 (`text-yellow-600`)
- 文字：深黃色 (`text-yellow-900`)

**為什麼用黃色？**
- 🟡 警示色，吸引注意
- 🟡 表示「注意，有多個 sheets」
- 🟡 不是錯誤（不用紅色）
- 🟡 不是普通資訊（不用藍色）

**位置**：
- 在「Field Mapping」標題下方
- 在欄位映射表格上方
- 整個寬度，很顯眼

---

## 🐛 故障排除

### Q1: 為什麼看不到 sheet 選擇器？

**A**: 
- 您的 Excel 只有一個 sheet
- 選擇器只在多個 sheets 時顯示
- 這是正常的

### Q2: 切換 sheet 後，之前的映射消失了？

**A**: 
- 這是**預期行為**
- 不同 sheet 可能有不同的欄位
- 系統自動重置映射，避免錯誤
- 請重新進行欄位映射

### Q3: 切換 sheet 很慢？

**A**: 
- 如果 sheet 資料量很大（> 10,000 行），可能需要幾秒鐘
- 會顯示 loading 狀態
- 請耐心等待

### Q4: 某個 sheet 是空的？

**A**: 
- 系統會顯示錯誤訊息
- 不會切換到空白 sheet
- 保持原有的 sheet

### Q5: 能否預設載入 Sheet2？

**A**: 
- 目前預設載入第一個 sheet
- 未來可以考慮：
  - 記住使用者上次選擇的 sheet
  - 智能檢測哪個 sheet 有資料
  - 讓使用者設定預設 sheet

---

## 📁 修改的檔案

### src/views/EnhancedExternalSystemsView.jsx

**新增 States**：
```javascript
const [workbook, setWorkbook] = useState(null);
const [sheetNames, setSheetNames] = useState([]);
const [selectedSheet, setSelectedSheet] = useState('');
```

**修改函數**：
- `handleFileChange()` - 讀取所有 sheets
- `handleTypeSelect()` - 重置 sheet 相關 states

**新增函數**：
- `handleSheetChange()` - 切換 sheet

**新增 UI**：
- Sheet 選擇器（黃色提示框 + 下拉選單）

---

## 🚀 測試建議

### 測試案例 1：單一 Sheet

**Excel**：
```
工作簿.xlsx
  └─ Sheet1 (資料)
```

**預期結果**：
- ✅ 正常載入
- ✅ 不顯示 sheet 選擇器

### 測試案例 2：多個 Sheets（資料在第一個）

**Excel**：
```
工作簿.xlsx
  ├─ Sheet1 (資料) ← 資料在這裡
  └─ Sheet2 (空白)
```

**預期結果**：
- ✅ 載入 Sheet1 資料
- ✅ 顯示 sheet 選擇器
- ✅ 可以切換到 Sheet2（會顯示錯誤：空白）

### 測試案例 3：多個 Sheets（資料在第二個）

**Excel**：
```
工作簿.xlsx
  ├─ Sheet1 (空白或其他)
  └─ Sheet2 (資料) ← 實際資料在這裡
```

**預期結果**：
- ⚠️ 預設載入 Sheet1（可能是錯的）
- ✅ 顯示 sheet 選擇器
- ✅ 使用者切換到 Sheet2
- ✅ 載入正確的資料

### 測試案例 4：三個以上 Sheets

**Excel**：
```
工作簿.xlsx
  ├─ Sheet1 (說明)
  ├─ Sheet2 (範本)
  ├─ Sheet3 (資料) ← 實際資料
  └─ Sheet4 (備份)
```

**預期結果**：
- ✅ 下拉選單顯示所有 4 個 sheets
- ✅ 可以自由切換
- ✅ 每次切換都重新載入資料

---

## 💡 使用建議

### 最佳實務

1. **檢查 Excel 結構**
   - 上傳前確認資料在哪個 sheet
   - 如果有多個 sheets，記下資料所在的 sheet 名稱

2. **使用 Sheet 選擇器**
   - 上傳後立即檢查是否顯示 sheet 選擇器
   - 如果資料不對，切換到正確的 sheet

3. **命名 Sheets**
   - 給 sheets 有意義的名稱（如「Price History」、「Goods Receipt」）
   - 避免使用預設名稱（Sheet1, Sheet2）

4. **整理 Excel**
   - 把實際資料放在第一個 sheet
   - 或者只保留一個 sheet
   - 刪除不需要的 sheets

### Excel 檔案準備

**✅ 推薦結構**：
```
工作簿.xlsx
  └─ Price History (唯一 sheet，包含資料)
```

**⚠️ 可行但需要選擇**：
```
工作簿.xlsx
  ├─ 說明 (第一個 sheet，但沒有資料)
  └─ Price History (第二個 sheet，實際資料)
     ↑ 需要手動切換到這裡
```

**❌ 不推薦**：
```
工作簿.xlsx
  ├─ Sheet1 (空白)
  ├─ Sheet2 (空白)
  ├─ Sheet3 (資料)
  ├─ Sheet4 (備份)
  └─ Sheet5 (筆記)
     ↑ 太多 sheets，容易混淆
```

---

## 🎉 總結

### ✅ 完成的功能

- 讀取所有 sheets
- 顯示 sheet 選擇器（多個 sheets 時）
- 即時切換 sheet
- 自動重置映射
- 詳細的通知訊息
- 錯誤處理

### 🎯 解決的問題

- ✅ **解決讀取錯誤 sheet** 的問題
- ✅ **解決 AI 映射失敗**（因為讀取錯誤資料）
- ✅ **解決日期格式錯誤**（因為讀取空白 sheet）
- ✅ **提升使用者體驗**（可以自由切換）

### 💡 使用方式

1. **上傳 Excel**
2. **檢查通知訊息**（有幾個 sheets？）
3. **如果顯示黃色選擇器** → 確認是否為正確的 sheet
4. **如果不對** → 切換到正確的 sheet
5. **繼續映射和驗證**

**現在您可以上傳包含多個 sheets 的 Excel 了！** 🚀



