# 文件入口

這個 repo 的主文件已收斂成少量高價值入口，優先讀這些：

- [../README.md](../README.md): 產品化總覽與快速啟動
- [DEMO.md](DEMO.md): 5 分鐘 demo 腳本與樣本資料路徑
- [ARCHITECTURE.md](ARCHITECTURE.md): 系統拓撲、責任切分、主要 request flow
- [DEPLOYMENT.md](DEPLOYMENT.md): Supabase、Edge Functions、前端、ML API 部署方式
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md): 目前能力邊界與已知限制
- [../CHANGELOG.md](../CHANGELOG.md): release notes

## 產品文件

- [USER_MANUAL_zh-TW.md](USER_MANUAL_zh-TW.md)
- [SPECIFICATION_zh-TW.md](SPECIFICATION_zh-TW.md)
- [DIGITAL_WORKER_PRD_zh-TW.md](DIGITAL_WORKER_PRD_zh-TW.md)
- [DIGITAL_WORKER_GAP_ANALYSIS_zh-TW.md](DIGITAL_WORKER_GAP_ANALYSIS_zh-TW.md)
- [LEARNED_COMPANY_TEMPLATE_ENGINE_zh-TW.md](LEARNED_COMPANY_TEMPLATE_ENGINE_zh-TW.md)

## 工程參考

- [planning_api_contract.md](planning_api_contract.md)
- [forecast_contract.md](forecast_contract.md)
- [phase1_runbook.md](phase1_runbook.md)
- [telemetry_schema.md](telemetry_schema.md)
- [training_pipeline.md](training_pipeline.md)
- [WORKSPACES.md](WORKSPACES.md)

## 團隊協作

- [../CONTRIBUTING.md](../CONTRIBUTING.md): PR、測試、文件與 ADR 工作方式
- [adr/README.md](adr/README.md): 架構決策紀錄索引
- [WORKSPACES.md](WORKSPACES.md): npm workspace 邊界與整合面維護方式
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md): staging 到 production 的可執行流程
- [QA_GO_LIVE_GATE.md](QA_GO_LIVE_GATE.md): 上線前回歸測試矩陣

## 歷史資料

- [archive/](archive/)
- [guides/](guides/)

`archive/` 與 `guides/` 仍保留大量實作細節、驗收記錄與故障排查，但不再是理解 repo 的主入口。重構報告、狀態報告、AI Agent 執行紀錄等內部整理文件也已視為歷史材料。
