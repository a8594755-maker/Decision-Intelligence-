# One-shot Import with Chunking: 實作摘要

## 概述
成功將 One-shot Import 升級為「真正一鍵全吃」功能，支援 >1000 rows 的 chunk 分批寫入、sheet-level idempotency、中途 abort、進度條與可下載報告。

---

## Phase 1: Domain/Service 層 — Chunk Ingest Pipeline

### 1.1 新增檔案：`src/services/chunkIngestService.js`

**功能：**
- `chunkRows(rows, chunkSize)`: 將資料切分為多個 chunks
- `ingestInChunks({ strategy, userId, uploadType, rows, ... })`: 
  - 自動偵測 RPC 類型並 cap chunk size 到 800
  - 逐 chunk 呼叫 `strategy.ingest(...)`
  - 支援 `AbortController.signal` 中途取消
  - 回報 chunk-level 進度 (`onProgress` callback)
  - 錯誤隔離：單一 chunk 失敗不影響其他 chunks

**關鍵常數：**
- `DEFAULT_CHUNK_SIZE = 500`
- `RPC_MAX_CHUNK_SIZE = 800` (保留 buffer，實際 RPC limit 為 1000)

---

### 1.2 修改檔案：`src/services/uploadStrategies.js`

**更新：**
1. 所有 strategy 的 `ingest` 方法新增參數：
   - `fileName` (string)
   - `sheetName` (string)
   - `options` (object, 可選)
2. 所有 strategy 的 data payload 新增欄位：
   - `ingest_key: options.idempotencyKey || null`
3. 新增 helper function：
   - `getIdempotencyKey({ batchId, sheetName, uploadType })`: 生成穩定的 idempotency key

**影響範圍：**
- `GoodsReceiptStrategy`
- `PriceHistoryStrategy`
- `SupplierMasterStrategy`
- `BomEdgeStrategy`
- `DemandFgStrategy`
- `PoOpenLinesStrategy`
- `InventorySnapshotsStrategy`
- `FgFinancialsStrategy`

---

## Phase 2: 交易一致性 / Idempotency

### 2.1 新增 SQL Migration：`database/one_shot_chunk_idempotency.sql`

**內容：**
1. **建立 `ingest_sheet_runs` 表：**
   - `id uuid` (PK)
   - `user_id uuid` (FK to auth.users)
   - `batch_id uuid` (FK to import_batches)
   - `sheet_name text`
   - `upload_type text`
   - `idempotency_key text` (UNIQUE constraint: user_id, idempotency_key)
   - `status text` (running | succeeded | failed | aborted)
   - `started_at`, `finished_at`, `total_rows`, `saved_rows`, `error_rows`, `chunks_completed`, `chunks_total`, `error jsonb`
   - RLS policies (users can view/insert/update their own runs)

2. **為 facts 表新增 `ingest_key` 欄位：**
   - `suppliers`, `materials`, `goods_receipts`, `price_history`, `bom_edges`, `demand_fg`, `po_open_lines`, `inventory_snapshots`, `fg_financials`
   - 欄位定義：`ingest_key text` (nullable, indexed by `user_id, ingest_key`)

3. **新增 RPC function：**
   - `check_ingest_key_support() -> boolean`: 檢查 migration 是否已部署

**執行方式：**
1. 登入 Supabase Dashboard
2. 前往 SQL Editor
3. 複製 `database/one_shot_chunk_idempotency.sql` 完整內容
4. 執行（可分段執行，若欄位已存在會自動跳過）

---

### 2.2 新增檔案：`src/services/sheetRunsService.js`

**功能：**
- `checkIngestKeySupport()`: 呼叫 RPC 檢查 DB 是否支援 idempotency
- `upsertSheetRun({ userId, batchId, sheetName, uploadType, idempotencyKey, ... })`: 建立/更新 sheet run 記錄
- `updateSheetRun(userId, idempotencyKey, updates)`: 更新 sheet run 狀態 (succeeded/failed/aborted)
- `findSucceededRun(userId, idempotencyKey)`: 查詢是否已成功匯入過
- `deletePreviousDataByIngestKey(userId, ingestKey, uploadType)`: 刪除同一 idempotency key 的舊資料（實現 idempotent delete-before-insert）
- `getSheetRunHistory(userId, limit)`: 查詢歷史記錄

---

## Phase 3: One-shot Import Service — 逐 sheet + chunk + 報告

### 3.1 修改檔案：`src/services/oneShotImportService.js`

**重構內容：**

#### A) `generateSheetPlans(workbook, fileName)`
- 移除 1000 rows hard limit（改為 soft warning）
- `maxRowsPerSheet` 提升為 10000
- 新增 `needsChunking` 欄位到 plan（標記是否需要分批）

#### B) `importWorkbookSheets({ userId, workbook, fileName, sheetPlans, options })`
**新參數：**
- `options.chunkSize` (default: 500)
- `options.signal` (AbortController.signal)
- `options.forceRerun` (是否強制重新執行已成功的 sheet)

**流程：**
1. 呼叫 `checkIngestKeySupport()` 檢查 DB 是否支援 idempotency
2. 對每個 enabled sheet 呼叫 `importSingleSheet(...)`
3. 若 `signal.aborted`，立刻停止並標記 sheet 為 'ABORTED'
4. 回傳完整 report：
   - `totalSheets`, `enabledSheets`, `succeededSheets`, `failedSheets`, `skippedSheets`
   - `hasIngestKeySupport` (boolean)
   - `sheetReports`: 每個 sheet 的詳細結果（包含 `chunks` 陣列）

#### C) `importSingleSheet(...)` (新增 internal function)
**流程：**
1. Parse sheet → auto-map → validate/clean
2. 建立 `import_batches` 記錄
3. 生成 `idempotencyKey = getIdempotencyKey({ batchId, sheetName, uploadType })`
4. **Idempotency check**: 若 `hasIngestKeySupport` 且已成功匯入過（`findSucceededRun`），則 skip
5. **Idempotent deletion**: 呼叫 `deletePreviousDataByIngestKey` 刪除同一 idempotency key 的舊資料
6. 建立 `ingest_sheet_runs` 記錄 (status: 'running')
7. 呼叫 `ingestInChunks({ strategy, rows, chunkSize, signal, idempotencyKey, ... })`
8. 更新 `import_batches` 與 `ingest_sheet_runs` 為 'succeeded' 或 'failed'
9. 錯誤處理：catch 後標記為 'failed' 並記錄 error JSON

---

## Phase 4: UI — 真正的一鍵全吃（進度條 + Abort + Download report）

### 4.1 修改檔案：`src/views/EnhancedExternalSystemsView.jsx`

**新增狀態：**
- `chunkSize` (number, default: 500)
- `abortController` (AbortController | null)

**更新狀態：**
- `oneShotProgress`: 新增 `chunkIndex`, `totalChunks`, `savedSoFar` 欄位

**UI 更新：**

#### A) Step 1: 新增 Chunk Size 下拉選單
```jsx
{oneShotEnabled && (
  <div className="pl-8 pt-2 border-t ...">
    <label>Chunk Size (rows per batch)</label>
    <select value={chunkSize} onChange={(e) => setChunkSize(Number(e.target.value))}>
      <option value={200}>200 (Safest for RPC)</option>
      <option value={500}>500 (Recommended)</option>
      <option value={800}>800 (Faster, near RPC limit)</option>
      <option value={1000}>1000 (Maximum)</option>
    </select>
    <p>{chunkSize >= 800 ? '⚠ Large chunk size may fail...' : '✓ Safe chunk size...'}</p>
  </div>
)}
```

#### B) Step 2.5 (Sheet Plans): Abort 按鈕（匯入中顯示）
```jsx
{saving && (
  <button onClick={handleAbortImport} className="...">
    <X className="w-4 h-4" />
    Abort Import
  </button>
)}
```

#### C) Progress Bar: 全局 + Chunk 雙層進度
```jsx
{saving && oneShotProgress.stage && (
  <div className="...">
    {/* 全局進度：Sheet X / Total */}
    <div>Sheet {oneShotProgress.current} / {oneShotProgress.total}</div>
    <div className="progress-bar" style={{ width: `${(current/total)*100}%` }} />
    
    {/* Chunk 進度 */}
    {oneShotProgress.stage === 'ingesting' && totalChunks > 0 && (
      <div>
        <div>Chunk {chunkIndex} / {totalChunks}</div>
        <div className="progress-bar-chunk" style={{ width: `${(chunkIndex/totalChunks)*100}%` }} />
        <div>{savedSoFar} rows saved</div>
      </div>
    )}
  </div>
)}
```

#### D) Result Summary: Download Report 按鈕
```jsx
{oneShotResult && (
  <div>
    <button onClick={() => {
      const json = JSON.stringify(oneShotResult, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `oneshot-import-report-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }}>
      <Download /> Download Report (JSON)
    </button>
    
    {/* Summary table with chunk details */}
    <table>
      <thead><tr><th>Sheet</th><th>Type</th><th>Status</th><th>Saved</th><th>Chunks</th></tr></thead>
      <tbody>
        {oneShotResult.sheetReports.map(sr => (
          <tr>
            <td>{sr.sheetName}</td>
            <td>{sr.uploadType}</td>
            <td>{sr.status}</td>
            <td>{sr.savedCount}</td>
            <td>{sr.chunks ? `${sr.chunks.filter(c => c.status === 'success').length}/${sr.chunks.length}` : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)}
```

#### E) Idempotency Warning
```jsx
{!oneShotResult.hasIngestKeySupport && (
  <div className="warning">
    ⚠ DB 未部署 chunk-idempotency（請執行 <code>database/one_shot_chunk_idempotency.sql</code>）
  </div>
)}
```

**關鍵函式：**
- `handleOneShotImport()`: 
  - 建立 `AbortController`
  - 呼叫 `importWorkbookSheets({ ..., options: { chunkSize, signal, onProgress } })`
  - 處理 `ABORTED` error
  - `finally` block 重置 `abortController = null`
- `handleAbortImport()`: 
  - 呼叫 `abortController.abort()`
  - 顯示「Aborting...」通知

---

## Phase 5: 最小驗收指令與文件

### 5.1 新增檔案：`ONE_SHOT_CHUNK_QA.md`

**內容：**
- 靜態驗收（npm run build）
- 手動功能驗收（5 個 Test Cases）:
  1. >1000 rows chunk ingest
  2. Abort 中途取消
  3. Idempotency（重送不疊資料）
  4. 混合成功/失敗 sheets（錯誤隔離）
  5. Chunk Size 對 RPC 類型的影響
- Fallback 驗證:
  1. DB 未部署 idempotency migration
  2. Chunk 全部失敗
- 最終檢查清單

### 5.2 新增檔案：`ONE_SHOT_CHUNK_IMPLEMENTATION_SUMMARY.md` (本文件)

---

## 檔案清單

### 新增檔案 (6)
1. `src/services/chunkIngestService.js` - Chunk 分批邏輯
2. `src/services/sheetRunsService.js` - Sheet run 追蹤與 idempotency
3. `database/one_shot_chunk_idempotency.sql` - DB schema migration
4. `ONE_SHOT_CHUNK_QA.md` - 驗收指令與 test cases
5. `ONE_SHOT_CHUNK_IMPLEMENTATION_SUMMARY.md` - 實作摘要（本文件）

### 修改檔案 (3)
1. `src/services/uploadStrategies.js` - 新增 `ingest_key` 支援
2. `src/services/oneShotImportService.js` - 重構為 chunk + idempotency 架構
3. `src/views/EnhancedExternalSystemsView.jsx` - UI 新增 chunk size、progress bar、abort、download report

---

## Fallback 機制

### 1. DB 未部署 idempotency migration
**行為：**
- `checkIngestKeySupport()` 回傳 `false`
- UI 顯示警告：「DB 未部署 chunk-idempotency，已降級」
- 功能仍可運行，但：
  - 重複上傳會疊資料
  - 無 idempotent delete
- **不會 crash**

### 2. Chunk 全部失敗
**行為：**
- `ingestInChunks` 拋出 error：「All X chunks failed. Check chunk errors for details.」
- Sheet 標記為 'failed'
- 報告中包含每個 chunk 的錯誤訊息
- 其他 sheets 不受影響（錯誤隔離）

### 3. RPC payload 過大
**行為：**
- `chunkIngestService` 自動偵測 RPC strategy（by constructor name）
- 自動 cap `effectiveChunkSize = min(chunkSize, 800)`
- Console log: `[ChunkIngest] Sheet "..." (...): X rows → Y chunks (size: 800)`

---

## 驗收狀態

### 靜態驗收
✅ `npm run build` 成功（0 errors, some warnings about dynamic imports）

### 手動驗收（待測試）
⏳ Test Case 1: >1000 rows chunk ingest  
⏳ Test Case 2: Abort 中途取消  
⏳ Test Case 3: Idempotency（重送不疊資料）  
⏳ Test Case 4: 混合成功/失敗 sheets  
⏳ Test Case 5: RPC chunk size cap  

### Fallback 驗收（待測試）
⏳ Fallback 1: DB 未部署 migration  
⏳ Fallback 2: Chunk 全部失敗  

---

## 後續擴充建議

1. **CSV 報告下載**：除了 JSON，提供 CSV 格式報告（更易於用 Excel 檢視）
2. **Chunk 重試機制**：允許單個 chunk 失敗後自動重試 1-2 次
3. **並行 chunk 寫入**：若 DB 支援，可考慮同時寫入多個 chunks（需評估 RLS/transaction 影響）
4. **Sheet 優先級排序**：允許使用者調整 sheet 匯入順序（例如：先匯 suppliers 再匯 bom_edges）
5. **歷史報告查詢**：在 UI 提供「查看過去匯入記錄」功能（from `ingest_sheet_runs`）

---

## 已知限制

1. **RPC limit**: `goods_receipt` 和 `price_history` 走 RPC，單次 payload 不得超過 1000 rows（已自動 cap 到 800）
2. **Browser 記憶體**: 單一檔案若包含超過 10 萬 rows，可能導致 browser 記憶體不足（xlsx 解析階段）
3. **Idempotency 範圍**: 僅限 sheet-level（同一 sheet 重送會刪除舊資料），無法做到 row-level idempotency
4. **Abort 延遲**: Abort 發生時，當前正在寫入的 chunk 會完成後才停止（無法立即中斷 DB 寫入操作）

---

## 結論

本次實作成功實現「真正一鍵全吃」的 One-shot Import：
- ✅ 支援 >1000 rows（自動 chunk）
- ✅ Sheet-level idempotency（重送不疊資料）
- ✅ 中途 abort（用戶可隨時取消）
- ✅ 詳細進度條（全局 + chunk 雙層）
- ✅ 可下載報告（JSON 格式）
- ✅ 錯誤隔離（單一 sheet 失敗不影響其他）
- ✅ Fallback 保護（DB 未部署時不 crash）

驗收完成後即可投入生產使用。
