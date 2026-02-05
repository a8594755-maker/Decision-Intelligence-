# UI Components 使用指南

這是 SmartOps 專案的 UI 元件庫，使用 Tailwind CSS v4 構建，無外部依賴。

## 📦 元件清單

### 現有元件
- ✅ **Card** - 卡片容器
- ✅ **Button** - 按鈕（支援多種變體）
- ✅ **Badge** - 狀態標籤
- ✅ **Modal** - 對話框

### 新增元件
- 🆕 **Table** - 表格容器
- 🆕 **Select** - 下拉選擇器
- 🆕 **SidePanel** - 側邊面板

---

## 🔧 使用方式

### 1. Table 元件

基本表格容器，支援 sticky header、hover、點選樣式。

#### 基本用法

```jsx
import { Table } from '../components/ui';

const columns = [
  { key: 'id', label: 'ID', align: 'left', width: '80px' },
  { key: 'name', label: '名稱', align: 'left' },
  { key: 'status', label: '狀態', align: 'center' },
  { key: 'amount', label: '金額', align: 'right' }
];

const data = [
  { id: '001', name: '產品A', status: 'active', amount: 1000 },
  { id: '002', name: '產品B', status: 'inactive', amount: 2000 }
];

<Table
  columns={columns}
  data={data}
  onRowClick={(row) => console.log('點擊:', row)}
  selectedRowId="001"
  stickyHeader={true}
  emptyMessage="暫無資料"
/>
```

#### 自定義 Cell 渲染

```jsx
<Table
  columns={columns}
  data={data}
  renderCell={(column, row, value) => {
    if (column.key === 'status') {
      return (
        <Badge type={value === 'active' ? 'success' : 'danger'}>
          {value}
        </Badge>
      );
    }
    if (column.key === 'amount') {
      return `$${value.toLocaleString()}`;
    }
    return value;
  }}
/>
```

#### Props

| Prop | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `columns` | Array | `[]` | 欄位定義 |
| `data` | Array | `[]` | 資料陣列 |
| `onRowClick` | Function | - | 點擊列的回調 |
| `selectedRowId` | string | - | 選中列的 ID |
| `renderCell` | Function | - | 自定義 cell 渲染 |
| `stickyHeader` | boolean | `true` | 是否固定表頭 |
| `emptyMessage` | string | `'暫無資料'` | 空狀態訊息 |
| `emptyIcon` | ReactNode | - | 空狀態圖示 |

#### 欄位定義 (Column)

```javascript
{
  key: 'columnKey',      // 資料的 key
  label: '欄位名稱',      // 顯示名稱
  align: 'left',         // left | center | right
  width: '120px',        // 欄位寬度（可選）
  sortable: true         // 是否可排序（可選）
}
```

---

### 2. Select 元件

原生 `<select>` 的樣式化包裝，支援鍵盤操作。

#### 基本用法

```jsx
import { Select } from '../components/ui';

// 方式 1: 使用字串陣列
<Select
  options={['選項1', '選項2', '選項3']}
  value={selectedValue}
  onChange={(value) => setSelectedValue(value)}
  placeholder="請選擇"
/>

// 方式 2: 使用物件陣列
<Select
  options={[
    { value: 'opt1', label: '選項1' },
    { value: 'opt2', label: '選項2' }
  ]}
  value={selectedValue}
  onChange={(value) => setSelectedValue(value)}
/>
```

#### 搭配 SelectGroup（帶標籤）

```jsx
import { SelectGroup, Select } from '../components/ui';

<SelectGroup
  label="工廠選擇"
  required={true}
  error={error}
  helperText="請選擇您的工廠"
>
  <Select
    options={plants}
    value={selectedPlant}
    onChange={setSelectedPlant}
  />
</SelectGroup>
```

#### Props (Select)

| Prop | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `options` | Array | `[]` | 選項陣列（string[] 或 object[]） |
| `value` | string | - | 當前選中值 |
| `onChange` | Function | - | 變更回調 |
| `placeholder` | string | `'請選擇'` | 預設提示文字 |
| `disabled` | boolean | `false` | 是否禁用 |
| `size` | string | `'md'` | 尺寸 (sm, md, lg) |

#### Props (SelectGroup)

| Prop | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `label` | string | - | 標籤文字 |
| `error` | string | - | 錯誤訊息 |
| `helperText` | string | - | 提示文字 |
| `required` | boolean | `false` | 是否必填 |

---

### 3. SidePanel 元件

右側詳情面板，桌面端固定，行動端變抽屜。

#### 桌面模式（固定在頁面中）

```jsx
import { SidePanel, SidePanelSection, SidePanelRow } from '../components/ui';
import { Package } from 'lucide-react';

// 未選取時的空狀態
const emptyState = (
  <div className="flex items-center justify-center h-full">
    <div className="text-center text-slate-500">
      <Package className="w-16 h-16 mx-auto mb-2 text-slate-300" />
      <p>點選一筆料號查看明細</p>
    </div>
  </div>
);

// 使用在頁面佈局中
<div className="grid grid-cols-12 gap-4">
  {/* 左側內容 */}
  <div className="col-span-8">
    <YourTable />
  </div>
  
  {/* 右側 SidePanel */}
  <div className="col-span-4">
    <SidePanel
      width="desktop"
      isOpen={!!selectedItem}
      title={selectedItem?.name}
      onClose={() => setSelectedItem(null)}
      emptyState={emptyState}
    >
      <SidePanelSection title="基本資訊" icon={Package}>
        <SidePanelRow label="料號" value={selectedItem?.code} />
        <SidePanelRow label="庫存" value={selectedItem?.stock} highlight />
      </SidePanelSection>
    </SidePanel>
  </div>
</div>
```

#### 行動模式（Overlay + Drawer）

```jsx
// 從右側滑入的抽屜
<SidePanel
  width="mobile"
  position="right"
  isOpen={isOpen}
  title="詳細資訊"
  onClose={() => setIsOpen(false)}
>
  <p>內容...</p>
</SidePanel>
```

#### Props (SidePanel)

| Prop | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `isOpen` | boolean | `false` | 是否開啟 |
| `onClose` | Function | - | 關閉回調 |
| `title` | string | - | 標題 |
| `children` | ReactNode | - | 內容 |
| `emptyState` | ReactNode | - | 空狀態內容 |
| `width` | string | `'desktop'` | 模式 (desktop/mobile) |
| `position` | string | `'right'` | 位置 (left/right) |

#### Props (SidePanelSection)

| Prop | 類型 | 說明 |
|------|------|------|
| `title` | string | 區塊標題 |
| `icon` | Component | Lucide 圖示元件 |
| `children` | ReactNode | 區塊內容 |

#### Props (SidePanelRow)

| Prop | 類型 | 說明 |
|------|------|------|
| `label` | string | 標籤 |
| `value` | string/number | 值 |
| `highlight` | boolean | 是否高亮顯示 |

---

## 🎨 樣式特色

### Dark Mode 支援
所有元件均支援 Dark Mode，自動根據 `dark:` class 調整。

### 響應式設計
- Table: 自動水平滾動
- Select: 自適應寬度
- SidePanel: 桌面固定，行動抽屜

### 互動反饋
- Hover 效果
- Focus 狀態
- Disabled 狀態
- Loading 狀態

---

## 🔍 完整範例

### RiskDashboard 整合範例

```jsx
import React, { useState } from 'react';
import { Table, Select, SidePanel, SidePanelSection, SidePanelRow } from '../components/ui';
import { Package, AlertTriangle } from 'lucide-react';

const RiskDashboardExample = () => {
  const [selectedItem, setSelectedItem] = useState(null);
  const [filterPlant, setFilterPlant] = useState('all');

  const columns = [
    { key: 'item', label: '料號', align: 'left' },
    { key: 'plant', label: '工廠', align: 'left' },
    { key: 'risk', label: '風險', align: 'center' },
    { key: 'days', label: '撐幾天', align: 'right' }
  ];

  const data = [
    { id: '1', item: 'PN-001', plant: 'PL01', risk: 'critical', days: 3 },
    { id: '2', item: 'PN-002', plant: 'PL02', risk: 'warning', days: 10 }
  ];

  const emptyState = (
    <div className="flex flex-col items-center justify-center h-full text-slate-500">
      <Package className="w-16 h-16 mb-3 text-slate-300" />
      <p>點選列查看詳細資訊</p>
    </div>
  );

  return (
    <div className="p-4 space-y-4">
      {/* 篩選器 */}
      <div className="flex gap-4">
        <Select
          options={['all', 'PL01', 'PL02']}
          value={filterPlant}
          onChange={setFilterPlant}
          placeholder="選擇工廠"
        />
      </div>

      {/* 主內容 */}
      <div className="grid grid-cols-12 gap-4">
        {/* 左側表格 */}
        <div className="col-span-8">
          <Table
            columns={columns}
            data={data}
            selectedRowId={selectedItem?.id}
            onRowClick={setSelectedItem}
            emptyIcon={<Package className="w-16 h-16" />}
          />
        </div>

        {/* 右側詳情 */}
        <div className="col-span-4">
          <SidePanel
            width="desktop"
            isOpen={!!selectedItem}
            title={selectedItem?.item}
            onClose={() => setSelectedItem(null)}
            emptyState={emptyState}
          >
            <SidePanelSection title="風險資訊" icon={AlertTriangle}>
              <SidePanelRow label="工廠" value={selectedItem?.plant} />
              <SidePanelRow 
                label="剩餘天數" 
                value={`${selectedItem?.days} 天`} 
                highlight 
              />
            </SidePanelSection>
          </SidePanel>
        </div>
      </div>
    </div>
  );
};
```

---

## ⚡ 效能建議

### Table
- 大量資料時使用虛擬滾動（可考慮 `react-window`）
- 使用 `React.memo` 包裝 row 元件

### Select
- 選項過多時考慮搜尋功能
- 使用 `useMemo` 快取格式化選項

### SidePanel
- 避免在 children 中放置過重的元件
- 使用懶載入載入詳情資料

---

## 🔧 擴展建議

如需更進階功能，可考慮：

1. **Table 排序**：添加 `TableHeader` 元件支援
2. **Select 搜尋**：添加 `searchable` prop
3. **SidePanel 寬度調整**：添加拖曳調整功能

---

## 📝 注意事項

1. **無外部依賴**：所有元件僅使用 Tailwind CSS v4
2. **鍵盤可用**：Select 支援 Tab 切換、Enter 選擇
3. **無障礙**：添加了基本的 ARIA 屬性
4. **Dark Mode**：自動支援，無需額外配置

---

最後更新：2026-02-04
