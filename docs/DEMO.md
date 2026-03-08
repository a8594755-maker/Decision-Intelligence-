# Demo Guide

## 目的

用最短路徑展示這個 repo 不是單一頁面原型，而是可串起資料匯入、AI 分析、規劃、風險、模擬與治理的決策工作台。

## Demo 前準備

- 前端已啟動：`npm run dev`
- ML API 已啟動：`python run_ml_api.py`
- `.env.local` 已依 [.env.example](../.env.example) 設定
- Supabase 專案可登入，並已有測試使用者
- `ai-proxy` Edge Function 已部署，且已設定 `GEMINI_API_KEY` / `DEEPSEEK_API_KEY`

## 建議 Demo 路徑

1. 登入系統後先停在 Command Center (`/`)
   說明這裡是決策入口，不是單純 dashboard，會同時顯示 KPI、最近活動、系統健康。

2. 切到 Plan Studio (`/plan`)
   上傳 [public/sample_data/test_data.xlsx](../public/sample_data/test_data.xlsx)。

3. 用同一筆資料說明 workflow
   重點放在資料 profiling、欄位 mapping、驗證、forecast、optimize、report 串接，而不是逐項展示所有卡片。

4. 切到 Forecast Studio (`/forecast`)
   說明這裡是模型與預測結果的工作區，和計畫頁是分工而不是重複功能。

5. 切到 Risk Center (`/risk`)
   展示風險例外、what-if、風險對補貨決策的影響。

6. 切到 Digital Twin (`/digital-twin`) 與 Scenario Studio (`/scenarios`)
   強調系統不只生成單次建議，也能比較策略、做模擬驗證。

7. 最後到 Settings (`/settings`)
   說明 AI 金鑰改由 Supabase Edge Function secrets 管理，這是可部署系統，不是把 API key 放前端的 demo。

## Demo 資料

- 主要樣本工作簿：`public/sample_data/test_data.xlsx`
- 原始樣本 CSV：`sample_data/`
- 如果要做更戲劇化的風險情境，可參考 [DEMO_RED_LIGHT_SCENARIO.md](DEMO_RED_LIGHT_SCENARIO.md)

## Demo 時的避坑建議

- 如果 `ai-proxy` 尚未配置完成，不要現場硬示範 AI 文本品質，改講 workflow 與系統邊界。
- 如果 ML API 沒有啟動，避免承諾即時計算結果；先展示資料流與畫面結構。
- 不要把 archive 裡的實作總結當 demo 材料。demo 應聚焦在產品流，不是開發過程。
