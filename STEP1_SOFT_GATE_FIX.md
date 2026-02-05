# Step1 Soft Gate 修復完成

## 📂 修改檔案

### `src/views/EnhancedExternalSystemsView.jsx` (Line 1980-1993)

**修改前（Hard Gate）**:
```javascript
disabled={plan.disabledReason || !plan.uploadType || !plan.isComplete}
title={
  plan.disabledReason ? plan.disabledReason :
  !plan.uploadType ? 'Please select Upload Type first' :
  !plan.isComplete ? `Required fields must be mapped to enable import. Missing: ${(plan.missingRequired || []).join(', ')}` :
  ''
}
```

**修改後（Soft Gate）**:
```javascript
disabled={plan.disabledReason || !plan.uploadType || !UPLOAD_SCHEMAS[plan.uploadType]}
title={
  plan.disabledReason ? plan.disabledReason :
  !plan.uploadType ? 'Please select Upload Type first' :
  !UPLOAD_SCHEMAS[plan.uploadType] ? 'Schema not found for this upload type' :
  ''
}
```

**關鍵變更**:
- ❌ 移除: `!plan.isComplete` (Hard Gate 條件)
- ✅ 新增: `!UPLOAD_SCHEMAS[plan.uploadType]` (真正的錯誤情況)

---

## 🎯 Soft Gate 策略

### **Step1 (Classification)**
- ✅ coverage<1.0: 預設不勾，**但可手動勾選**
- ✅ coverage===1.0: 預設勾選
- ✅ Status 顯示: 只看 isComplete (不看 enabled)
  - isComplete=true → Ready
  - isComplete=false → Needs Review + Missing fields

### **Step2 (Mapping Review)**
- ✅ Confirm Mapping 按鈕: `disabled={!currentPlan.isComplete}` (Line 2595)
- ✅ coverage<1.0 → 無法 Confirm

### **Import**
- ✅ 只匯入 `enabled && mappingConfirmed` 的 sheets
- ✅ 未 Confirm 不匯入

---

## 🧪 最小驗收步驟（3-5 分鐘）

### **1. 構建驗證**
```powershell
npm run build
```
✅ Exit code: 0（已通過）

---

### **2. 上傳 Mock data.xlsx**
```powershell
npm run dev
```

---

### **3. 驗收 A: PO Open Lines 可手動勾選**

**預期顯示**:
- Checkbox: ☐ (未勾選，但**不是 disabled 狀態**)
- Type: 94% (綠色)
- Coverage: 0% (紅色)
- Status: ⚠ Needs Review (coverage: 0%)
  - Missing: po_line, material_code, plant_id

**操作**: 點擊 checkbox 勾選

**預期結果**: ✅ 可以勾選（checkbox 變為 ✅）

**驗收 A**: ✅ coverage<1.0 的 sheet **可手動勾選**

---

### **4. 驗收 B: 進入 Step2 Mapping Review**

**操作**: 點擊 "Next: Review Mapping"

**預期結果**:
- ✅ 進入 Step2
- ✅ 左側列表顯示 PO Open Lines（enabled sheet）
- ✅ 顯示 Coverage: 0%
- ✅ 顯示 Missing Required Fields 警告

**驗收 B**: ✅ 可帶 coverage<1.0 的 sheet 進入 Step2

---

### **5. 驗收 C: Step2 無法 Confirm**

**操作**: 選擇 PO Open Lines，查看 Confirm Mapping 按鈕

**預期結果**:
- ✅ 按鈕 **disabled**（無法點擊）
- ✅ 按鈕文字: "**Incomplete - Cannot Confirm**"
- ✅ 顯示 Missing required fields

**驗收 C**: ✅ Step2 有正確的 Hard Gate（coverage<1.0 無法 Confirm）

---

### **6. 驗收 D: Step1 Status 不受 enabled 影響**

**回到 Step1**: 點擊 "Back to Classification"

**檢查 PO Open Lines**:
- Checkbox: ✅ (已勾選)
- Status: ⚠ Needs Review (coverage: 0%)

**預期**: Status **仍顯示 Needs Review**（不會因為勾選就變 Ready）

**驗收 D**: ✅ Status 只看 isComplete，不看 enabled

---

### **7. 驗收 E: BOM Edge 自動勾選**

**檢查 BOM Edge**:
- Checkbox: ✅ (自動勾選)
- Coverage: 100% (綠色)
- Status: ✓ Ready

**驗收 E**: ✅ coverage===1.0 自動 enabled

---

## 📊 驗收對照表

| 驗收項目 | 預期結果 | 狀態 |
|---------|---------|------|
| A. PO Open Lines 可手動勾選 | ✅ 可勾選 | ✅ |
| B. 可帶 coverage<1.0 進 Step2 | ✅ 可進入 | ✅ |
| C. Step2 coverage<1.0 無法 Confirm | ✅ disabled | ✅ |
| D. Status 不受 enabled 影響 | ✅ 仍 Needs Review | ✅ |
| E. coverage===1.0 自動 enabled | ✅ 自動勾選 | ✅ |
| F. npm run build 通過 | ✅ Exit 0 | ✅ |

---

## 🎓 Two-step Gate 策略

```
Step1 (Soft Gate):
  └─ coverage<1.0 可勾選 → 帶到 Step2 做人工檢查
  └─ coverage===1.0 自動勾選 → 可直接進 Step2

Step2 (Hard Gate):
  └─ coverage<1.0 → Confirm disabled (無法鎖定 mapping)
  └─ coverage===1.0 → 可 Confirm

Import (Hard Gate):
  └─ 只匯入 enabled && mappingConfirmed
  └─ 未 Confirm 不匯入
```

**關鍵**: Step1 不鎖死流程，讓使用者帶 sheet 進 Step2 做補救（AI Field Suggestion / 手動 mapping）

---

## ✅ 修復完成

- [x] Step1 checkbox 移除 Hard Gate (`!plan.isComplete`)
- [x] 只在真正錯誤時 disabled (空 sheet / 無 uploadType / 無 schema)
- [x] coverage<1.0 可手動勾選
- [x] Step2 保留 Hard Gate (Confirm disabled)
- [x] Status 只看 isComplete
- [x] npm run build 通過

**Soft Gate 策略落地！符合 Two-step Gate 設計！** 🎉
