const fs = require('fs');

console.log('正在修復 App.jsx...');

// 讀取備份文件
const content = fs.readFileSync('src/App.jsx.backup', 'utf-8');
const lines = content.split('\n');

// 新的 imports
const newImports = `import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  LayoutDashboard, Database, Activity, AlertTriangle, BarChart3, Bot, Settings, LogOut,
  Search, User, Upload, RefreshCw, CheckCircle, AlertCircle, FileText, TrendingUp,
  Menu, X, ChevronRight, Download, Moon, Sun, Send, Sparkles, Loader2, Building2
} from 'lucide-react';

// --- Import UI Components ---
import { Card, Button, Badge } from './components/ui';
import { SimpleLineChart, SimpleBarChart } from './components/charts';

// --- Import Services ---
import { supabase } from './services/supabaseClient';
import { callGeminiAPI } from './services/geminiAPI';

// --- Import Utils ---
import { extractSuppliers, calculateDataStats, formatTimestamp } from './utils/dataProcessing';

// --- Import Views ---
import SupplierManagementView from './views/SupplierManagementView';

// Mock Data
`;

// 找到 MOCK_ALERTS 的位置
let mockDataIdx = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const MOCK_ALERTS')) {
    mockDataIdx = i;
    break;
  }
}

// 找到 HomeView 組件的位置 (第一個 View 組件)
let homeViewIdx = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const HomeView')) {
    homeViewIdx = i;
    break;
  }
}

// 組合新內容
let newContent = newImports;

// 添加 Mock Data
newContent += lines.slice(mockDataIdx, mockDataIdx + 2).join('\n') + '\n\n';

// 添加主 App 組件 (從 Mock Data 到 HomeView 之間的部分)
newContent += lines.slice(mockDataIdx + 3, homeViewIdx).join('\n') + '\n\n';

// 更新 navItems (手動插入)
const navItemsPattern = /const navItems = \[.*?\];/s;
const mainAppSection = newContent;
const updatedNavItems = `const navItems = [
    { id: 'home', label: 'Home', icon: LayoutDashboard },
    { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
    { id: 'external', label: 'External Systems', icon: Database },
    { id: 'suppliers', label: '供應商管理', icon: Building2 },
    { id: 'alerts', label: 'Alerts', icon: AlertTriangle },
    { id: 'analytics', label: 'Analytics', icon: TrendingUp },
    { id: 'decision', label: 'Decision AI', icon: Bot }
  ];`;

newContent = newContent.replace(navItemsPattern, updatedNavItems);

// 更新 renderView (添加 suppliers case)
const renderViewPattern = /(const renderView = \(\) => \{[\s\S]*?case 'external':.*?;)([\s\S]*?case 'integration':)/;
const supplierCase = `\n      case 'suppliers': return <SupplierManagementView addNotification={addNotification} />;`;
newContent = newContent.replace(renderViewPattern, `$1${supplierCase}$2`);

// 添加所有 View 組件 (從 HomeView 到文件結束)
newContent += lines.slice(homeViewIdx).join('\n');

// 寫入文件
fs.writeFileSync('src/App.jsx', newContent, 'utf-8');

console.log('✅ App.jsx 修復完成！');
console.log('   - 已添加新的 imports');
console.log('   - 已刪除舊的組件定義');
console.log('   - 已更新 navItems');
console.log('   - 已添加供應商管理路由');
console.log('   - 保留了所有 View 組件');
