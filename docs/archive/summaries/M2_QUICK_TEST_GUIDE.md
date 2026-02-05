# M2 Profit at Risk 快速测试指南

## 🧪 测试场景

### 场景 1: 无 FG Financials（使用 fallback - 推荐先测）

#### 步骤：
1. **确认无 financials 数据**
   ```sql
   SELECT COUNT(*) FROM fg_financials WHERE user_id = 'your-user-id';
   -- 应返回 0
   ```

2. **前往 Risk Dashboard**

3. **验收点：**
   - ✅ KPI Card 3 显示金额（如 `$125,450`）
   - ✅ 不再显示 "Coming Week 2"
   - ✅ 显示 "Critical: $XXX"
   
   - ✅ 蓝色提示框显示：
     ```
     • Profit at Risk: Assumption: $10/unit (FG financials not loaded)
     ```
   
   - ✅ 表格新增 `Profit at Risk` 列
   - ✅ 所有行显示 `~` 符号（表示使用 assumption）
   
   - ✅ 点击任一行，DetailsPanel 显示：
     - `[~ Assumption]` 黄色标签
     - Profit per unit: $10
     - Exposure qty: X
     - Profit at Risk: $XXX
     - 公式：`profitAtRisk = max(0, gapQty) * profitPerUnit`

---

### 场景 2: 有真实 FG Financials

#### 步骤：
1. **上传 fg_financials.xlsx**
   - 确保包含字段：`material_code`, `profit_per_unit`, `currency`
   - 至少 5-10 笔数据

2. **前往 Risk Dashboard**

3. **验收点：**
   - ✅ KPI Card 3 显示真实计算的金额
   
   - ✅ 蓝色提示框显示：
     ```
     • Profit at Risk: Using real financials for 5 items, Assumption: $10/unit for others
     ```
   
   - ✅ 表格中：
     - 有 financials 的行：无 `~` 符号
     - 无 financials 的行：显示 `~` 符号
   
   - ✅ 点击有 financials 的行，DetailsPanel 显示：
     - `[✓ Real financials]` 绿色标签
     - Profit per unit: $XX（真实值）
     - Profit at Risk: $XXX（真实计算）

---

### 场景 3: Sample Data 模式

#### 步骤：
1. **点击 "Load Sample Data"**

2. **验收点：**
   - ✅ 模式标签显示 `[SAMPLE DATA]`
   - ✅ KPI Card 3 显示估算金额
   - ✅ 所有行显示 `~` 符号
   - ✅ 蓝色提示框显示：
     ```
     • Profit at Risk: Assumption: $10/unit
     ```

---

## 📊 预期数值范围（真实数据）

### 根据用户数据（Inv: 1159, PO: 64）

假设：
- **Critical items**: 45（无 PO）
- **Warning items**: 125（僅 1 次 PO 或 qty 很小）
- **平均 gapQty**: 30
- **profitPerUnit**: $10（fallback）

**预期 Total Profit at Risk：**
```
Critical: 45 * 30 * 10 = $13,500
Warning: 125 * 15 * 10 = $18,750
Total: ≈ $32,250
```

若有真实 financials（profitPerUnit = $25）：
```
Total: ≈ $80,625
```

---

## 🔍 验证 Checklist

### KPI Cards
- [ ] Card 3 显示非 $0 金额
- [ ] 显示 "Critical: $XXX"
- [ ] 移除 "Coming Week 2"
- [ ] 红色主题

### 蓝色提示框
- [ ] 显示 "Profit at Risk" 说明
- [ ] 使用 fallback 时显示 "Assumption: $10/unit"
- [ ] 有 financials 时显示 "Using real financials for X items"

### RiskTable
- [ ] 新增 `Profit at Risk` 列
- [ ] 可点击排序
- [ ] 显示货币符号（$ 或 ¥）
- [ ] 使用 assumption 的行显示 `~`
- [ ] Critical 行金额为红色

### DetailsPanel
- [ ] 新增 Section 5: Profit at Risk
- [ ] 显示来源标签（绿色/黄色/灰色）
- [ ] 显示 Profit per unit, Exposure qty, Profit at Risk
- [ ] 显示公式
- [ ] Missing 时显示警告

---

## 🐛 常见问题

### Q1: Profit at Risk 全是 $0？
**A:** 检查 `gapQty` 是否全是 0。Profit at Risk = max(0, gapQty) * profitPerUnit。

### Q2: 表格没有 Profit at Risk 列？
**A:** 确保代码已保存并刷新浏览器。检查 Console 是否有错误。

### Q3: 蓝色提示框没有 "Profit at Risk" 说明？
**A:** 检查 `profitSummary.usingFallback` 是否为 true。

### Q4: DetailsPanel 没有来源标签？
**A:** 检查 `details.profitAtRiskReason` 是否有值（REAL/ASSUMPTION/MISSING）。

### Q5: 所有行都显示 ~，但我已上传 financials？
**A:** 检查 financials 的 `material_code` 是否与 inventory/PO 的料号匹配（注意大小写、trim）。

---

## 📸 预期画面

### KPI Cards（M2 更新）
```
┌────────────────────────────────────────────────────────┐
│  🔴 45          🟡 125         💰 $32,250   🕐 2026-02-04 │
│  Critical       3 buckets      Total Profit  資料批次    │
│  風險項         內風險          at Risk       時間        │
│  總計 1180     CRITICAL +      Critical:                 │
│               WARNING          $22,500                   │
└────────────────────────────────────────────────────────┘
```

### 表格（新增 Profit at Risk 列）
```
┌──────────────────────────────────────────────────────────────────────┐
│ 料號      │工廠 │狀態│Net │Gap│Next   │Profit at Risk│操作│
├───────────┼─────┼────┼────┼───┼───────┼──────────────┼────┤
│PART-A101  │TW01 │🔴  │250 │50 │W06    │   $1,250~    │ ⓘ │ ← ~ 表示 assumption
│PART-B202  │CN01 │🔴  │100 │30 │N/A    │     $750     │ ⓘ │ ← 真实 financials
│PART-C303  │US01 │🟡  │150 │10 │W07    │     $100~    │ ⓘ │
└──────────────────────────────────────────────────────────────────────┘
```

### DetailsPanel（M2 新增 Section 5）
```
┌─ Profit at Risk（貨幣化）─────────────────────────┐
│ [~ Assumption]                                     │
│                                                    │
│ Profit per unit              $10                  │
│ Exposure qty                  50                  │
│ ─────────────────────────────────────────────────│
│ Profit at Risk             $500                   │
│ ─────────────────────────────────────────────────│
│ profitAtRisk = max(0, gapQty) * profitPerUnit    │
└────────────────────────────────────────────────────┘
```

---

## 🎉 测试完成标志

- [ ] KPI Card 3 显示非 $0 金额
- [ ] 表格有 Profit at Risk 列
- [ ] 可点击列标题排序
- [ ] 使用 assumption 的行有 `~` 符号
- [ ] DetailsPanel 有 Section 5
- [ ] 来源标签显示正常（绿色/黄色/灰色）
- [ ] 公式显示正确
- [ ] 蓝色提示框有 assumption 说明
- [ ] Console 无错误

---

**测试准备：** ✅ Ready  
**预期时间：** 5 分钟  
**推荐顺序：** 场景 2（无 financials）→ 场景 3（Sample Data）→ 场景 1（有 financials）
