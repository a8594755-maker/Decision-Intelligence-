/**
 * UI Components 使用範例
 * 
 * 這個檔案展示如何使用新增的 Table、Select、SidePanel 元件
 * 可以直接複製貼上到你的專案中使用
 */

import React, { useState, useMemo } from 'react';
import { 
  Table, 
  Select, 
  SidePanel, 
  SidePanelSection, 
  SidePanelRow,
  Badge,
  Button 
} from './index';
import { Package, AlertTriangle, TrendingDown, RefreshCw } from 'lucide-react';

// ========== 範例 1: 基本 Table 使用 ==========

export const BasicTableExample = () => {
  const [selectedRow, setSelectedRow] = useState(null);

  const columns = [
    { key: 'id', label: 'ID', align: 'left', width: '80px' },
    { key: 'name', label: '名稱', align: 'left' },
    { key: 'status', label: '狀態', align: 'center', width: '100px' },
    { key: 'amount', label: '金額', align: 'right', width: '120px' }
  ];

  const data = [
    { id: '001', name: '產品 A', status: 'active', amount: 1000 },
    { id: '002', name: '產品 B', status: 'inactive', amount: 2000 },
    { id: '003', name: '產品 C', status: 'active', amount: 1500 }
  ];

  // 自定義 cell 渲染
  const renderCell = (column, row, value) => {
    if (column.key === 'status') {
      return (
        <Badge type={value === 'active' ? 'success' : 'danger'}>
          {value === 'active' ? '啟用' : '停用'}
        </Badge>
      );
    }
    if (column.key === 'amount') {
      return `$${value.toLocaleString()}`;
    }
    return value;
  };

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">基本 Table 範例</h2>
      <Table
        columns={columns}
        data={data}
        selectedRowId={selectedRow?.id}
        onRowClick={setSelectedRow}
        renderCell={renderCell}
        stickyHeader
        emptyIcon={<Package className="w-16 h-16" />}
        emptyMessage="暫無資料"
      />
      {selectedRow && (
        <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <p className="text-sm">選中項目：{selectedRow.name}</p>
        </div>
      )}
    </div>
  );
};

// ========== 範例 2: Select 使用 ==========

export const SelectExample = () => {
  const [plant, setPlant] = useState('');
  const [status, setStatus] = useState('');

  const plantOptions = [
    { value: 'pl01', label: '工廠 PL01' },
    { value: 'pl02', label: '工廠 PL02' },
    { value: 'pl03', label: '工廠 PL03' }
  ];

  const statusOptions = ['全部', '啟用', '停用'];

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">Select 範例</h2>
      
      {/* 基本 Select */}
      <div className="space-y-2">
        <label className="block text-sm font-medium">選擇工廠</label>
        <Select
          options={plantOptions}
          value={plant}
          onChange={setPlant}
          placeholder="請選擇工廠"
        />
      </div>

      {/* 使用字串陣列 */}
      <div className="space-y-2">
        <label className="block text-sm font-medium">選擇狀態</label>
        <Select
          options={statusOptions}
          value={status}
          onChange={setStatus}
          size="sm"
        />
      </div>

      {/* 顯示選擇結果 */}
      <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg">
        <p className="text-sm">工廠：{plant || '未選擇'}</p>
        <p className="text-sm">狀態：{status || '未選擇'}</p>
      </div>
    </div>
  );
};

// ========== 範例 3: SidePanel（桌面模式）==========

export const SidePanelDesktopExample = () => {
  const [selectedItem, setSelectedItem] = useState(null);

  const items = [
    { id: '1', code: 'PN-001', name: '料號 A', stock: 100, risk: 'critical' },
    { id: '2', code: 'PN-002', name: '料號 B', stock: 500, risk: 'warning' },
    { id: '3', code: 'PN-003', name: '料號 C', stock: 1000, risk: 'low' }
  ];

  const emptyState = (
    <div className="flex flex-col items-center justify-center h-full text-slate-500">
      <Package className="w-16 h-16 mb-3 text-slate-300" />
      <p className="text-center">點選左側列表中的項目<br />查看詳細資訊</p>
    </div>
  );

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">SidePanel 桌面模式範例</h2>
      
      <div className="grid grid-cols-12 gap-4">
        {/* 左側列表 */}
        <div className="col-span-7 space-y-2">
          {items.map(item => (
            <div
              key={item.id}
              onClick={() => setSelectedItem(item)}
              className={`p-4 rounded-lg border cursor-pointer transition-colors ${
                selectedItem?.id === item.id
                  ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-500'
                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-blue-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold">{item.code}</p>
                  <p className="text-sm text-slate-600">{item.name}</p>
                </div>
                <Badge type={item.risk === 'critical' ? 'danger' : item.risk === 'warning' ? 'warning' : 'success'}>
                  {item.risk}
                </Badge>
              </div>
            </div>
          ))}
        </div>

        {/* 右側 SidePanel */}
        <div className="col-span-5">
          <SidePanel
            width="desktop"
            isOpen={!!selectedItem}
            title={selectedItem?.code}
            onClose={() => setSelectedItem(null)}
            emptyState={emptyState}
          >
            <div className="space-y-4">
              <SidePanelSection title="基本資訊" icon={Package}>
                <SidePanelRow label="料號" value={selectedItem?.code} />
                <SidePanelRow label="名稱" value={selectedItem?.name} />
                <SidePanelRow label="庫存" value={selectedItem?.stock} highlight />
              </SidePanelSection>

              <SidePanelSection title="風險評估" icon={AlertTriangle}>
                <SidePanelRow label="風險等級" value={selectedItem?.risk} />
                <SidePanelRow label="狀態" value="正常" />
              </SidePanelSection>
            </div>
          </SidePanel>
        </div>
      </div>
    </div>
  );
};

// ========== 範例 4: SidePanel（行動模式/抽屜）==========

export const SidePanelMobileExample = () => {
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">SidePanel 行動模式範例（抽屜）</h2>
      
      <Button onClick={() => setIsPanelOpen(true)}>
        開啟側邊欄
      </Button>

      <SidePanel
        width="mobile"
        position="right"
        isOpen={isPanelOpen}
        title="詳細資訊"
        onClose={() => setIsPanelOpen(false)}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            這是一個從右側滑入的抽屜式面板，適合用於行動裝置。
          </p>
          
          <SidePanelSection title="範例內容" icon={Package}>
            <SidePanelRow label="項目 1" value="內容 A" />
            <SidePanelRow label="項目 2" value="內容 B" />
            <SidePanelRow label="項目 3" value="內容 C" highlight />
          </SidePanelSection>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
            <Button variant="primary" onClick={() => setIsPanelOpen(false)}>
              關閉
            </Button>
          </div>
        </div>
      </SidePanel>
    </div>
  );
};

// ========== 範例 5: 完整整合（模擬 RiskDashboard）==========

const MOCK_DATA = [
  { id: '1', item: 'PN-001', plant: 'PL01', risk: 'critical', days: 3, stock: 50 },
  { id: '2', item: 'PN-002', plant: 'PL02', risk: 'warning', days: 10, stock: 200 },
  { id: '3', item: 'PN-003', plant: 'PL01', risk: 'low', days: 30, stock: 1000 },
  { id: '4', item: 'PN-004', plant: 'PL03', risk: 'critical', days: 5, stock: 80 }
];

export const CompleteIntegrationExample = () => {
  const [selectedPlant, setSelectedPlant] = useState('all');
  const [selectedRisk, setSelectedRisk] = useState('all');
  const [selectedItem, setSelectedItem] = useState(null);

  // 篩選資料
  const filteredData = useMemo(() => {
    return MOCK_DATA.filter(item => {
      if (selectedPlant !== 'all' && item.plant !== selectedPlant) return false;
      if (selectedRisk !== 'all' && item.risk !== selectedRisk) return false;
      return true;
    });
  }, [selectedPlant, selectedRisk]);

  // Table 欄位
  const columns = [
    { key: 'item', label: '料號', align: 'left' },
    { key: 'plant', label: '工廠', align: 'left', width: '100px' },
    { key: 'risk', label: '風險', align: 'center', width: '120px' },
    { key: 'days', label: '撐幾天', align: 'right', width: '100px' },
    { key: 'stock', label: '庫存', align: 'right', width: '100px' }
  ];

  // 自定義 cell
  const renderCell = (column, row, value) => {
    if (column.key === 'risk') {
      const badgeType = value === 'critical' ? 'danger' : value === 'warning' ? 'warning' : 'success';
      return <Badge type={badgeType}>{value}</Badge>;
    }
    if (column.key === 'days') {
      const color = value <= 7 ? 'text-red-600' : value <= 14 ? 'text-yellow-600' : 'text-green-600';
      return <span className={`font-semibold ${color}`}>{value}</span>;
    }
    if (column.key === 'stock') {
      return value.toLocaleString();
    }
    return value;
  };

  // Empty state
  const emptyState = (
    <div className="flex flex-col items-center justify-center h-full text-slate-500">
      <Package className="w-16 h-16 mb-3 text-slate-300" />
      <p className="text-center">點選表格中的料號<br />查看詳細風險資訊</p>
    </div>
  );

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🚨 風險儀表板（完整範例）</h1>
        <Button variant="secondary" icon={RefreshCw}>
          重新整理
        </Button>
      </div>

      {/* 篩選欄 */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1">
            <label className="block text-xs text-slate-600 dark:text-slate-400 mb-1">工廠</label>
            <Select
              options={[
                { value: 'all', label: '全部工廠' },
                { value: 'PL01', label: 'PL01' },
                { value: 'PL02', label: 'PL02' },
                { value: 'PL03', label: 'PL03' }
              ]}
              value={selectedPlant}
              onChange={setSelectedPlant}
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-slate-600 dark:text-slate-400 mb-1">風險等級</label>
            <Select
              options={[
                { value: 'all', label: '全部等級' },
                { value: 'critical', label: '🔴 Critical' },
                { value: 'warning', label: '🟡 Warning' },
                { value: 'low', label: '🟢 Low' }
              ]}
              value={selectedRisk}
              onChange={setSelectedRisk}
            />
          </div>
        </div>
      </div>

      {/* KPI 卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-3xl font-bold text-red-600">
                {filteredData.filter(d => d.risk === 'critical').length}
              </div>
              <div className="text-sm text-slate-600 dark:text-slate-400">Critical 項目</div>
            </div>
            <AlertTriangle className="w-8 h-8 text-red-600" />
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-3xl font-bold text-yellow-600">
                {filteredData.filter(d => d.risk === 'warning').length}
              </div>
              <div className="text-sm text-slate-600 dark:text-slate-400">Warning 項目</div>
            </div>
            <TrendingDown className="w-8 h-8 text-yellow-600" />
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-3xl font-bold text-slate-900 dark:text-slate-100">
                {filteredData.length}
              </div>
              <div className="text-sm text-slate-600 dark:text-slate-400">總計項目</div>
            </div>
            <Package className="w-8 h-8 text-slate-600" />
          </div>
        </div>
      </div>

      {/* 主內容：Table + SidePanel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 左側 Table */}
        <div className={selectedItem ? 'lg:col-span-8' : 'lg:col-span-12'}>
          <Table
            columns={columns}
            data={filteredData}
            selectedRowId={selectedItem?.id}
            onRowClick={setSelectedItem}
            renderCell={renderCell}
            stickyHeader
            emptyIcon={<Package className="w-16 h-16" />}
            emptyMessage="無符合條件的資料"
          />
        </div>

        {/* 右側 SidePanel */}
        {selectedItem && (
          <div className="lg:col-span-4">
            <SidePanel
              width="desktop"
              isOpen={!!selectedItem}
              title={`詳情：${selectedItem?.item}`}
              onClose={() => setSelectedItem(null)}
              emptyState={emptyState}
            >
              <div className="space-y-4">
                <SidePanelSection title="基本資訊" icon={Package}>
                  <SidePanelRow label="料號" value={selectedItem?.item} />
                  <SidePanelRow label="工廠" value={selectedItem?.plant} />
                  <SidePanelRow label="庫存" value={selectedItem?.stock.toLocaleString()} highlight />
                </SidePanelSection>

                <SidePanelSection title="風險評估" icon={AlertTriangle}>
                  <SidePanelRow label="風險等級" value={selectedItem?.risk} />
                  <SidePanelRow label="剩餘天數" value={`${selectedItem?.days} 天`} highlight />
                </SidePanelSection>

                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-xs text-blue-800 dark:text-blue-200">
                  💡 這是一個完整的整合範例，展示 Table + Select + SidePanel 如何協同工作
                </div>
              </div>
            </SidePanel>
          </div>
        )}
      </div>
    </div>
  );
};

// ========== 匯出所有範例 ==========

export default {
  BasicTableExample,
  SelectExample,
  SidePanelDesktopExample,
  SidePanelMobileExample,
  CompleteIntegrationExample
};
