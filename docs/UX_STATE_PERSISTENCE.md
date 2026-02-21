# UX 狀態持久化與導航（State Persistence & Back）

本文記錄「切分頁回來跳回首頁」修復與「上一頁」能力的決策與實作方式。

---

## 1. 問題與目標

- **P0 現象**：使用者在 Chrome 切到其他分頁後再切回 Decision-Intelligence，有時會回到首頁，或遺失當前頁面／Tab。
- **目標**：
  - 切回 Decision-Intelligence 分頁時，**保留原本頁面（route）與 tab**。
  - 重新整理時，**至少保留 route**；若有採用 tab/filter 策略，一併保留。
  - 主要 view 提供**上一頁**：優先 `history.back()`，無 history 時導回上層／首頁。

---

## 2. 原因說明

- **SPA 無 react-router**：本專案使用 History API（`pushState` / `popstate`）與自訂 `pathToView` / `viewToPath`，view 存在 React state。
- **狀態未完全綁 URL**：僅 pathname 與 view 同步，**tab、Upload 模式（單檔 / One-shot）** 未寫入 URL，重新整理或 bfcache 還原後會丟失。
- **切分頁回來**：部分環境下 tab 失焦／還原時會觸發重新整理或 state 還原，若未以 URL 為單一真相來源，容易回到預設（例如首頁）。

因此採用 **URL 為單一真相來源**：route + 必要 tab 都進 URL。

---

## 3. 實作策略（擇優）

採用 **URL query 存 tab / 模式**，不採用僅用 localStorage 的作法，理由：

- 可分享、可書籤、重新整理後一致。
- 與現有 pathname 同步機制一致，易維護。
- 無需設計過期策略。

具體做法：

1. **Route**  
   - 維持現有：pathname ↔ view 雙向同步，`lastVisitedPath` 僅作 fallback（例如未知 path 時）。

2. **Tab / 模式**  
   - 使用 **query**（如 `?tab=...`）：
     - **BOM Data**：`?tab=bom_edges` | `?tab=demand_fg`
     - **Forecasts**：`?tab=results` | `?tab=trace`
     - **Data Upload**：`?tab=upload` | `?tab=oneshot`
   - 讀取：view 掛載時從 `window.location.search` 解析，寫入：tab/模式變更時 `replaceState` 更新 query。

3. **切分頁回來**  
   - 監聽 **`visibilitychange`**：當 `document.visibilityState === 'visible'` 時，用**當前 pathname** 再算一次 view，若與目前 state 不同則 `setView`。  
   - 這樣即使 bfcache 或異常導致 state 錯亂，一切回分頁就以 URL 為準還原。

4. **上一頁**  
   - 在非首頁的 main 區塊顯示「上一頁」按鈕：
     - 有 history：`window.history.back()`。
     - 無 history（例如直接開連結）：`setView('home')`，避免按鈕無效或離開網站。

---

## 4. 涉及檔案與 API

| 項目 | 說明 |
|------|------|
| `src/utils/router.js` | 新增 `getSearchParams()`、`updateUrlSearch(params)`，供讀寫 query。 |
| `src/hooks/useUrlTabState.js` | Hook：從 URL 讀 tab、寫回 URL，並訂閱 `popstate` 以支援瀏覽器前進／後退。 |
| `src/App.jsx` | `useVisibilitySync`：切分頁回來依 pathname 還原 view；Back 按鈕邏輯。 |
| `src/views/BOMDataView.jsx` | Tab 使用 `useUrlTabState('bom_edges', 'tab', ['bom_edges', 'demand_fg'])`。 |
| `src/views/ForecastsView.jsx` | Tab 使用 `useUrlTabState('results', 'tab', ['results', 'trace'])`。 |
| `src/views/EnhancedExternalSystemsView.jsx` | 單檔／One-shot 模式與 `?tab=upload` | `?tab=oneshot` 雙向同步；`useEffect` 寫入 URL。 |

---

## 5. 驗收對照

- 切到其他分頁約 30 秒後切回：**仍停留在同頁（route 不變）**，且若該頁有 tab，tab 也維持（因已寫入 URL）。
- 重新整理：**至少 route 保留**；有使用 tab/query 的頁面，**tab／模式一併保留**。
- 上一頁：**主要頁面皆可用**；無 history 時不會壞掉，會回首頁。

---

## 6. 手動測試步驟（至少 5 步，含 Chrome 切分頁）

1. **Route + Tab 保留（切分頁）**  
   - 登入後進入 **Data → BOM Data**，切到 **FG 需求** tab，確認 URL 為 `/data/bom-data?tab=demand_fg`。  
   - 開新分頁（例如 about:blank），約 30 秒後切回 Decision-Intelligence。  
   - **預期**：仍為 BOM Data 頁且為 FG 需求 tab，URL 不變。

2. **重新整理保留 route + tab**  
   - 在 **Planning → Forecasts** 切到 **Trace** tab，URL 應為 `/planning/forecasts?tab=trace`。  
   - 按 F5 重新整理。  
   - **預期**：仍為 Forecasts 頁且為 Trace tab。

3. **Upload 模式保留**  
   - 進入 **Data → Data Upload**，勾選 **One-shot 匯入**，URL 應為 `/data/upload?tab=oneshot`。  
   - 重新整理。  
   - **預期**：仍為 Data Upload 且 One-shot 仍勾選。

4. **上一頁（有 history）**  
   - 依序：首頁 → BOM Data → Data Upload。  
   - 在 Data Upload 頁點 **上一頁**。  
   - **預期**：回到 BOM Data（或上一筆 history）。

5. **上一頁（無 history）**  
   - 用新分頁直接開啟 `https://<your-app>/data/upload`（或登入後唯一一筆 history）。  
   - 點 **上一頁**。  
   - **預期**：回到首頁，不關閉分頁、不報錯。

---

## 7. 未來的可選延伸

- 將 **filter 狀態**（如 BOM Data / Forecasts 的篩選欄位）以 query 參數保存，重新整理後還原。
- 為 **Import History** 等列表頁保留 `page`、`sort` 等於 URL，方便分享與還原。
