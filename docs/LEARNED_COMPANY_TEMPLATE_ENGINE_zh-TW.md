# Learned Company Template Engine

**對照產品：** Digital Worker Platform  
**文件類型：** System Design  
**文件版本：** 1.0  
**更新日期：** 2026-03-15  
**狀態：** Draft

---

## 1. 問題定義

Digital Worker 不應依賴產品方手寫固定模板。

不同公司即使做同一種工作，最終交付形式也可能完全不同：

- Excel 工作表結構不同
- KPI 定義與排序不同
- Dashboard 版面不同
- Manager summary 的語氣不同
- 例外事項與風險標記欄位不同
- 哪些資料問題要被明確記錄也不同

因此，產品不應預設「正確模板」，而應該：

**從公司過往被接受的產出中，學出這家公司的 house template。**

這個 house template 不是靜態 hardcode，而是：

- 可學習
- 可版本化
- 可審核
- 可回退
- 可提出優化建議

---

## 2. 核心原則

### 2.1 不由產品方手寫模板

平台只提供通用能力：

- 任務 intake
- 工具使用
- review / audit
- deliverable rendering
- style retrieval
- version control

平台不直接定義：

- 「月會一定有哪幾個 sheet」
- 「報告一定有哪些 KPI」
- 「Dashboard 一定長怎樣」

### 2.2 先學穩定版本，再提優化版本

輸出策略分成兩層：

- `Baseline Output`
  - 盡可能貼近公司已接受的常規產出
- `Improvement Proposal`
  - 在不偏離太遠的前提下，提出可讀性、結構、分析深度或視覺層次上的優化

### 2.3 歷史不是絕對真理，但必須被尊重

舊文件不代表最佳實務，但代表：

- 公司內部的共識
- 主管已習慣的閱讀方式
- 既有決策節奏

所以系統不能直接拋棄歷史格式，而應採取：

- `default to baseline`
- `opt-in to improvement`

### 2.4 學習結果必須可審計

系統不能只說「我覺得這家公司偏好這樣」。

每一項 learned template 都應能回答：

- 從哪些 exemplar 學到的
- 出現頻率多高
- 哪些規則是強規則
- 哪些只是偏好
- 哪些優化提案是 AI 新提出的
- 誰批准了新版本

---

## 3. 產品定義

Learned Company Template Engine 是 Digital Worker 的一個平台層能力。

它的責任不是直接執行任務，而是為每家公司建立一個 `Company Output Profile`，供所有 worker 在交付時使用。

### 3.1 它不是什麼

- 不是 prompt template library
- 不是固定報表模板市集
- 不是單純的 file retrieval
- 不是 fine-tune pipeline 本身

### 3.2 它是什麼

- exemplar ingestion pipeline
- style / structure extraction engine
- versioned company output profile store
- runtime retrieval layer
- controlled improvement proposal engine

---

## 4. 系統輸入與輸出

### 4.1 輸入

來源可以包括：

- 過去的 Excel 工作簿
- 過去的 Slides / Docs
- Email 摘要與週報
- 被主管批准的正式交付物
- Data issues log
- KPI summary
- 分析 memo
- 主管 review comments

每份 exemplar 需要最少 metadata：

- `company_id`
- `team_id`
- `document_type`
- `audience`
- `created_at`
- `approved_by`
- `approval_status`
- `task_type`
- `source_tool`

### 4.2 輸出

每家公司最終產生一個或多個 `Company Output Profile`：

- `Excel MBR Profile v1`
- `Weekly Ops Summary Profile v3`
- `Manager Email Update Profile v2`
- `QBR Deck Profile v5`

每個 profile 會描述：

- 結構規則
- 內容規則
- 命名規則
- 呈現規則
- 風險與例外記錄規則
- 優化允許範圍

---

## 5. 核心資料模型

### 5.1 Exemplars

`company_exemplars`

欄位建議：

- `id`
- `company_id`
- `team_id`
- `document_type`
- `deliverable_type`
- `file_id`
- `storage_ref`
- `approval_status`
- `approved_at`
- `approved_by`
- `task_type`
- `metadata_json`
- `ingested_at`

### 5.2 Extracted Signals

`company_exemplar_signals`

每份 exemplar 會被抽成結構化訊號，例如：

- sheet 名稱序列
- 欄位名稱
- KPI card 標題
- 圖表類型
- section 標題
- summary 用語
- issues log 欄位
- 常見 observation 語法

欄位建議：

- `id`
- `exemplar_id`
- `signal_type`
- `signal_key`
- `signal_value_json`
- `confidence`
- `source_path`

### 5.3 Output Profiles

`company_output_profiles`

欄位建議：

- `id`
- `company_id`
- `team_id`
- `profile_name`
- `document_type`
- `status`
- `version`
- `is_active`
- `profile_json`
- `derived_from_exemplar_ids`
- `approved_by`
- `approved_at`
- `created_by_mode`

其中 `created_by_mode` 可為：

- `learned`
- `human_edited`
- `ai_proposed`

### 5.4 Improvement Proposals

`company_output_profile_proposals`

欄位建議：

- `id`
- `base_profile_id`
- `proposed_profile_json`
- `proposal_reason`
- `diff_summary_json`
- `status`
- `reviewer_id`
- `approved_at`

---

## 6. Profile 內容結構

`profile_json` 不應只是 prompt。

它至少應包含以下幾塊：

### 6.1 Structure Layer

- 文件類型
- 常見 section 順序
- sheet 順序
- 必備工作表 / 附件
- KPI 區塊排列方式
- chart placement 規則

### 6.2 Semantic Layer

- 常見 KPI 定義
- 欄位對應與命名標準
- 風險標籤規則
- issue log 類別
- 常見商業問題框架

### 6.3 Presentation Layer

- 標題語氣
- 顏色 / 視覺規則
- 圖表偏好
- manager summary 長度
- bullet vs paragraph 偏好

### 6.4 Governance Layer

- 哪些欄位必須保留
- 哪些 section 可以新增
- 哪些變更必須 review
- 允許的優化範圍

### 6.5 Evidence Layer

- 這個 profile 來自哪些 exemplar
- 各規則的支持度
- 低信心規則
- 待確認規則

---

## 7. 學習流程

### 7.1 Exemplar Ingestion

使用者或 admin 上傳公司歷史檔案，標記其用途與品質：

- 這是否為正式對外 / 對內交付物
- 是否曾被主管批准
- 這份檔案屬於哪種任務
- 是否代表目前版本

### 7.2 Structural Extraction

系統抽取顯性結構：

- workbook / document 架構
- sheet 順序
- 欄位 schema
- chart 類型
- 視覺版面元素

### 7.3 Semantic Extraction

系統抽取隱性語義：

- KPI 定義與名稱
- 洞察表述方式
- issue log 欄位
- risk wording
- summary 語氣

### 7.4 Profile Synthesis

系統根據多份 exemplar 歸納出：

- 強規則：高一致性、低歧義
- 弱規則：常見偏好、允許變動
- 待確認規則：訊號不足或互相衝突

### 7.5 Human Confirmation

第一次建立 profile 時，不應自動上線。

需要由 manager / ops reviewer 進行：

- 規則確認
- 名稱調整
- baseline profile 核准

---

## 8. Runtime 使用方式

當 Digital Worker 接到一個新任務時，不是去選產品方模板，而是：

1. 判定任務類型與交付類型
2. 找到該公司對應的 active output profile
3. 將 profile 注入 deliverable generation 階段
4. 依 profile 輸出 baseline version
5. 若 improvement mode 開啟，再額外產生 proposal version

### 8.1 Runtime 決策順序

- `task intent`
- `company`
- `team`
- `document_type`
- `audience`
- `active profile`
- `tool policy`

### 8.2 若找不到 profile

只能走 fallback：

- 使用通用 deliverable profile
- 明確標示為 `generic draft`
- 不可冒充公司既有格式

---

## 9. 改版與優化機制

這一層是你要的關鍵。

### 9.1 Baseline Mode

輸出盡量貼近公司現行版本。

適用：

- 新公司剛上線
- 高風險交付
- 主管偏好穩定一致

### 9.2 Improvement Proposal Mode

系統在不破壞主體格式下，提出有限優化：

- 更清楚的 KPI 層次
- 更好的 issue log 欄位
- 更好的 summary 語言
- 更好的圖表排序
- 更好的 risk highlighting

### 9.3 Approval Flow

proposal 不應直接覆蓋 baseline。

流程：

1. 產出 `Current Version`
2. 產出 `Suggested Version`
3. 顯示差異與理由
4. 由 manager 批准
5. 批准後升級 profile version

### 9.4 Version Promotion

類似 model promotion：

- `draft`
- `candidate`
- `approved`
- `active`
- `retired`

---

## 10. 與現有 repo 的映射

目前 repo 裡已經有幾個可沿用的骨架：

### 10.1 可沿用

- `task / run / review / audit` 主幹
- `deliverable preview` 層
- `memory` 與 feedback 記錄
- `file upload` 與 dataset context
- `excel ops` 寫回能力

### 10.2 不應再擴大的舊假設

以下邏輯不應再當平台核心：

- `forecast / plan / risk` 為通用 step taxonomy
- `dataset_profile_id` 為所有任務中心
- `supply chain report` 為預設交付物

### 10.3 建議新增模組

- `src/services/companyExemplarService.js`
- `src/services/companyStyleExtractionService.js`
- `src/services/companyOutputProfileService.js`
- `src/services/profileProposalService.js`
- `src/services/profileRuntimeResolver.js`

---

## 11. 最小可行版本

第一版不需要做全自動學習全部格式。

### 11.1 MVP 範圍

- 支援 Excel 與 Doc 兩種 exemplar
- 可上傳 5-20 份已批准歷史檔案
- 自動抽取：
  - section / sheet 結構
  - KPI 名稱
  - issue log 欄位
  - summary 風格
- 產出一個 manager 可審核的 `candidate profile`
- 後續任務可用此 profile 產出 baseline draft

### 11.2 暫不做

- 完整 fine-tuning
- 自動學會所有圖表版面細節
- 完整跨部門 profile merge
- 無限泛化到所有 document 類型

---

## 12. 成功指標

不要只看產出速度，要看「穩定貼近公司慣例且可進化」。

核心指標：

- First-pass acceptance rate
- Output edit distance vs approved baseline
- Manager approval rate
- Profile adoption rate
- Improvement proposal acceptance rate
- Rollback rate
- Time-to-first-trusted-output
- Exemplar coverage per profile

---

## 13. 風險

### 13.1 盲目模仿壞流程

如果 exemplar 本身品質很差，系統可能學到壞習慣。

對策：

- exemplar quality gating
- approval weighting
- improvement proposal path

### 13.2 不同時期版本互相衝突

公司可能近一年改過報表邏輯。

對策：

- 強制帶時間戳
- 支援 profile version segmentation
- 允許 team / audience 維度切分

### 13.3 公司內部格式其實不一致

不同 manager 可能有不同偏好。

對策：

- profile scope 必須支援 `team / manager / document_type`
- 不要假設一家公司只有一種格式

### 13.4 過度優化破壞熟悉感

AI 提出的改善可能 technically 更好，但 manager 不接受。

對策：

- improvement 必須走 proposal flow
- baseline 不能被自動覆蓋

---

## 14. 一句話結論

你要的不是「不要模板」。

你要的是：

**不要由產品方硬編模板，而是讓系統從公司歷史交付物中學出可版本化、可審核、可優化的 house template。**

這個能力一旦成立，Digital Worker 才真的會像員工，而不是像一個只會套固定格式的報表工具。
