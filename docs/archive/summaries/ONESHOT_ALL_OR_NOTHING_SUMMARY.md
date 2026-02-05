# One-shot All-or-nothing Mode 實作摘要

## 功能概述
為 One-shot Import 新增兩種匯入模式：
- **Best-effort（預設）**：Sheet-level 隔離，成功的 sheets 先寫入，失敗的不影響其他
- **All-or-nothing**：若任一 sheet 失敗，rollback 所有已成功的 sheets（使用 ingest_key delete）

---

## 實作內容

### 1. UI 更新：`src/views/EnhancedExternalSystemsView.jsx`

#### 新增狀態
```javascript
const [oneShotMode, setOneShotMode] = useState('best-effort'); // 'best-effort' | 'all-or-nothing'
```

#### 新增 UI 元件：Import Mode Radio
位置：One-shot Import toggle 下方，Chunk Size 上方

```jsx
{oneShotEnabled && (
  <div className="pl-8 pt-2 border-t border-purple-200 dark:border-purple-700 space-y-4">
    {/* Import Mode */}
    <div>
      <label className="block text-sm font-medium text-purple-900 dark:text-purple-100 mb-2">
        Import Mode
      </label>
      <div className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="oneShotMode"
            value="best-effort"
            checked={oneShotMode === 'best-effort'}
            onChange={(e) => setOneShotMode(e.target.value)}
            disabled={loading}
            className="w-4 h-4 text-purple-600"
          />
          <span className="text-sm">
            <strong>Best-effort（推薦）</strong> - Sheet-level isolation
          </span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="oneShotMode"
            value="all-or-nothing"
            checked={oneShotMode === 'all-or-nothing'}
            onChange={(e) => setOneShotMode(e.target.value)}
            disabled={loading}
            className="w-4 h-4 text-purple-600"
          />
          <span className="text-sm">
            <strong>All-or-nothing</strong> - Rollback all if any fails
          </span>
        </label>
      </div>
      <p className="text-xs text-purple-600 mt-1.5">
        {oneShotMode === 'all-or-nothing' 
          ? '⚠ 若任一 sheet 失敗，所有已成功的 sheets 將被回滾（需 DB 已部署 chunk-idempotency）'
          : '✓ 每個 sheet 獨立匯入，失敗的 sheet 不影響其他成功的 sheets'}
      </p>
    </div>
    
    {/* Chunk Size ... */}
  </div>
)}
```

#### 傳遞 mode 參數到 service
```javascript
const result = await importWorkbookSheets({
  userId: user.id,
  workbook,
  fileName,
  sheetPlans,
  options: {
    strictMode,
    chunkSize,
    mode: oneShotMode, // 'best-effort' | 'all-or-nothing'
    signal: controller.signal,
    onProgress: ...
  }
});
```

#### 顯示 Rollback 警告（Result Summary）
```jsx
{oneShotResult && (
  <div className="...">
    {/* Rollback warning */}
    {oneShotResult.rolledBack && (
      <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
        <div className="flex items-center gap-2 font-semibold mb-1">
          <AlertTriangle className="w-4 h-4" />
          All-or-nothing Mode: Rollback Triggered
        </div>
        <p className="text-xs">
          由於某些 sheet 失敗，所有已成功的 sheets 已被回滾。資料庫中不會保留任何資料。
        </p>
      </div>
    )}
    
    {/* Mode indicator */}
    {oneShotResult.mode && (
      <div className="mb-3 p-2 bg-slate-50 border border-slate-200 rounded text-xs">
        Import Mode: <strong>{oneShotResult.mode === 'all-or-nothing' ? 'All-or-nothing' : 'Best-effort'}</strong>
      </div>
    )}
    
    {/* ... rest of summary ... */}
  </div>
)}
```

---

### 2. Service 更新：`src/services/oneShotImportService.js`

#### 接受 mode 參數
```javascript
export async function importWorkbookSheets({ userId, workbook, fileName, sheetPlans, options = {} }) {
  const {
    strictMode = false,
    chunkSize = DEFAULT_CHUNK_SIZE,
    mode = 'best-effort', // 'best-effort' | 'all-or-nothing'
    onProgress = () => {},
    signal = null,
    forceRerun = false
  } = options;
  
  // Check if ingest_key support is deployed
  const hasIngestKeySupport = await checkIngestKeySupport();
  
  // All-or-nothing requires ingest_key support
  if (!hasIngestKeySupport && mode === 'all-or-nothing') {
    console.warn('[One-shot] All-or-nothing mode requires ingest_key support, falling back to best-effort');
  }
  
  const report = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalSheets,
    enabledSheets: totalSheets,
    succeededSheets: 0,
    failedSheets: 0,
    skippedSheets: 0,
    hasIngestKeySupport,
    mode,
    rolledBack: false, // 標記是否觸發 rollback
    sheetReports: []
  };
  
  // Track succeeded sheets for rollback (All-or-nothing mode)
  const succeededSheetsForRollback = [];
  
  // ... rest of function
}
```

#### 記錄成功的 sheets（for rollback）
```javascript
for (let i = 0; i < enabledPlans.length; i++) {
  // ... import sheet ...
  
  if (sheetResult.status === 'IMPORTED') {
    report.succeededSheets++;
    
    // Track for rollback (All-or-nothing mode)
    if (mode === 'all-or-nothing' && hasIngestKeySupport && sheetResult.idempotencyKey) {
      succeededSheetsForRollback.push({
        sheetName,
        uploadType,
        idempotencyKey: sheetResult.idempotencyKey,
        savedCount: sheetResult.savedCount
      });
    }
    
  } else if (sheetResult.status === 'SKIPPED') {
    report.skippedSheets++;
  } else {
    report.failedSheets++;
    
    // All-or-nothing: rollback on any failure
    if (mode === 'all-or-nothing' && hasIngestKeySupport && succeededSheetsForRollback.length > 0) {
      console.log('[One-shot] All-or-nothing mode: Rolling back succeeded sheets due to failure');
      await rollbackSucceededSheets(succeededSheetsForRollback, userId);
      report.rolledBack = true;
    }
  }
}
```

#### 處理 Exception 與 Abort
```javascript
} catch (error) {
  console.error(`[One-shot] Failed to import sheet "${sheetName}":`, error);
  
  report.sheetReports.push({
    sheetName,
    uploadType,
    status: 'FAILED',
    reason: error.message || 'Unknown error',
    error: error.stack
  });
  report.failedSheets++;
  
  // All-or-nothing: rollback on exception
  if (mode === 'all-or-nothing' && hasIngestKeySupport && succeededSheetsForRollback.length > 0) {
    console.log('[One-shot] All-or-nothing mode: Rolling back succeeded sheets due to exception');
    await rollbackSucceededSheets(succeededSheetsForRollback, userId);
    report.rolledBack = true;
  }
}

// Check abort (在 loop 開始處)
if (signal?.aborted) {
  console.log('[One-shot] Aborted by user');
  report.sheetReports.push({
    sheetName,
    uploadType,
    status: 'ABORTED',
    reason: 'Import aborted by user'
  });
  
  // All-or-nothing: rollback on abort
  if (mode === 'all-or-nothing' && hasIngestKeySupport && succeededSheetsForRollback.length > 0) {
    console.log('[One-shot] All-or-nothing mode: Rolling back succeeded sheets due to abort');
    await rollbackSucceededSheets(succeededSheetsForRollback, userId);
    report.rolledBack = true;
  }
  
  break;
}
```

#### 新增 rollbackSucceededSheets 函式
```javascript
/**
 * Rollback succeeded sheets (All-or-nothing mode)
 * 使用 ingest_key 刪除已成功匯入的資料
 * 
 * @param {Array} succeededSheets - Array of { sheetName, uploadType, idempotencyKey, savedCount }
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function rollbackSucceededSheets(succeededSheets, userId) {
  console.log(`[One-shot] Rolling back ${succeededSheets.length} succeeded sheets...`);
  
  for (const sheet of succeededSheets) {
    try {
      console.log(`[One-shot] Rolling back "${sheet.sheetName}" (${sheet.uploadType}), ingest_key: ${sheet.idempotencyKey}`);
      
      const deletedCount = await deletePreviousDataByIngestKey(
        userId,
        sheet.idempotencyKey,
        sheet.uploadType
      );
      
      console.log(`[One-shot] Rolled back "${sheet.sheetName}": ${deletedCount} rows deleted`);
      
    } catch (error) {
      console.error(`[One-shot] Failed to rollback "${sheet.sheetName}":`, error);
      // 繼續回滾其他 sheets，不中斷
    }
  }
  
  console.log('[One-shot] Rollback completed');
}
```

#### 修改 importSingleSheet 返回值（包含 idempotencyKey）
```javascript
return {
  sheetName,
  uploadType,
  status: 'IMPORTED',
  savedCount: ingestResult.savedCount,
  batchId,
  errorCount: validationResult.errorRows?.length || 0,
  totalRows,
  chunks: ingestResult.chunks,
  warnings: ingestResult.warnings,
  sheetRunId,
  idempotencyKey: hasIngestKeySupport ? idempotencyKey : null // For rollback
};
```

---

## 技術架構

### 流程圖：All-or-nothing Mode

```
User selects "All-or-nothing" mode
  ↓
Import starts (importWorkbookSheets)
  ↓
succeededSheetsForRollback = []
  ↓
For each enabled sheet:
  ↓
  Import sheet (importSingleSheet)
  ↓
  ├─ Success (status = 'IMPORTED')
  │  ├─ report.succeededSheets++
  │  └─ succeededSheetsForRollback.push({ sheetName, uploadType, idempotencyKey, savedCount })
  │
  ├─ Skip (status = 'SKIPPED')
  │  └─ report.skippedSheets++
  │
  └─ Failure (status = 'FAILED' or exception)
     ├─ report.failedSheets++
     └─ if (mode === 'all-or-nothing' && succeededSheetsForRollback.length > 0):
        ├─ rollbackSucceededSheets(succeededSheetsForRollback, userId)
        │  ↓
        │  For each succeeded sheet:
        │    ├─ deletePreviousDataByIngestKey(userId, idempotencyKey, uploadType)
        │    └─ console.log(`Rolled back "${sheetName}": ${deletedCount} rows deleted`)
        │
        └─ report.rolledBack = true
  ↓
Return report (including rolledBack flag)
  ↓
UI displays rollback warning (red box)
```

---

## 關鍵決策與實作細節

### 1. Rollback 時機
All-or-nothing 模式下，以下情況會觸發 rollback：
1. **任一 sheet 匯入失敗**（`status = 'FAILED'`）
2. **任一 sheet 發生 exception**（catch block）
3. **使用者中途 abort**（`signal.aborted`）

### 2. Rollback 機制
- **使用 ingest_key 刪除**：呼叫 `deletePreviousDataByIngestKey(userId, idempotencyKey, uploadType)`
- **逐一回滾**：遍歷 `succeededSheetsForRollback` 陣列，逐個刪除
- **錯誤不中斷**：若某個 sheet 回滾失敗（catch），繼續回滾其他 sheets
- **無 transaction**：由於 Supabase 限制，無法使用 DB-level transaction，改用 application-level rollback

### 3. idempotencyKey 的角色
- **唯一識別**：`idempotencyKey = getIdempotencyKey({ batchId, sheetName, uploadType })`
- **格式**：`"batchId::sheetName::uploadType"`
- **寫入時機**：每個 row 寫入時帶上 `ingest_key` 欄位
- **刪除時機**：rollback 時根據 `ingest_key` 刪除該 sheet 的所有 rows

### 4. Fallback 處理
若 `hasIngestKeySupport = false`（DB 未部署 migration）：
- Console 警告：`All-or-nothing mode requires ingest_key support, falling back to best-effort`
- **自動降級為 Best-effort 模式**（不 crash）
- UI 顯示警告：「DB 未部署 chunk-idempotency」

### 5. Best-effort Mode（預設行為）
- **不記錄 succeededSheetsForRollback**
- **不觸發 rollback**
- 失敗的 sheet 不影響已成功的 sheets
- `report.rolledBack = false`

---

## 驗收狀態

### 靜態驗收
✅ `npm run build` 成功（0 errors）

### 手動驗收（待測試）
⏳ Test Case 1: Best-effort Mode — 失敗不影響成功  
⏳ Test Case 2: All-or-nothing Mode — 任一失敗則全部回滾 ⭐ **最重要**  
⏳ Test Case 3: All-or-nothing Mode — 全部成功則全部保留  
⏳ Test Case 4: All-or-nothing Mode — Abort 中途取消  
⏳ Test Case 5: All-or-nothing Mode without DB Support（Fallback）  

詳細測試指引請參考：`ONESHOT_ALL_OR_NOTHING_TEST.md`

---

## 相關檔案

### 修改檔案 (2)
1. `src/services/oneShotImportService.js` - 新增 rollback 邏輯與 rollbackSucceededSheets 函式
2. `src/views/EnhancedExternalSystemsView.jsx` - 新增 mode radio 與 rollback 顯示

### 新增檔案 (2)
1. `ONESHOT_ALL_OR_NOTHING_TEST.md` - 完整測試指引
2. `ONESHOT_ALL_OR_NOTHING_SUMMARY.md` - 本文件

### 依賴檔案（既有）
- `src/services/sheetRunsService.js` - `deletePreviousDataByIngestKey()` 函式
- `database/one_shot_chunk_idempotency.sql` - 必須先部署此 migration

---

## 未來優化建議

### 短期
1. **Rollback 進度顯示**：UI 顯示 "Rolling back sheet 1/3..."
2. **Rollback 報告詳細化**：Summary 中顯示每個 sheet 回滾了多少 rows
3. **Rollback Confirmation**：失敗時彈出確認對話框，讓使用者決定是否回滾

### 中期
1. **Partial Rollback**：允許使用者選擇性回滾某些 sheets（而非全部）
2. **Rollback History**：記錄 rollback 操作到 `ingest_sheet_runs` 表（新增 `rolled_back_at` 欄位）
3. **Rollback 失敗處理**：若 rollback 失敗，提供「手動清理」指引

### 長期
1. **DB-level Transaction**：若 Supabase 未來支援，改用真正的 transaction rollback
2. **Rollback Preview**：失敗時先顯示預覽（哪些 sheets 將被回滾），讓使用者確認
3. **Undo Rollback**：允許「反悔」rollback 操作（重新寫入已回滾的資料）

---

## 已知限制

1. **無 DB Transaction**：
   - 由於 Supabase 限制，無法使用 DB-level transaction
   - 改用 application-level rollback（逐一刪除）
   - 若 rollback 中途失敗（例如網路中斷），可能留下部分資料

2. **Rollback 不可見**：
   - `ingest_sheet_runs` 表中 status 仍為 'succeeded'（即使資料已刪除）
   - 未來可新增 `rolled_back_at` 欄位記錄

3. **Performance**：
   - Rollback 是同步操作（逐個刪除），可能耗時
   - 若 sheet 數量多（>10 個），rollback 可能需要幾秒鐘

---

## 結論

✅ **功能已完整實作**  
✅ **`npm run build` 成功**  
✅ **測試指引已提供**  

請依照 `ONESHOT_ALL_OR_NOTHING_TEST.md` 進行手動驗收測試，特別是 **Test Case 2**（最小驗收標準）。驗收通過後，功能即可投入生產使用。
