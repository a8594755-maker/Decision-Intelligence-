#!/usr/bin/env python3
"""
腳本：更新 App.jsx 整合新模組
"""

# 讀取原始文件
with open('src/App.jsx', 'r', encoding='utf-8-sig') as f:
    lines = f.readlines()

# 新的 imports
new_imports = """import React, { useState, useEffect, useRef } from 'react';
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

"""

# 找到第一個組件定義的位置（跳過舊的 imports 和 API 定義）
start_idx = 0
for i, line in enumerate(lines):
    if line.strip().startswith('// Mock Data'):
        start_idx = i
        break

# 如果沒找到 Mock Data，找 export default
if start_idx == 0:
    for i, line in enumerate(lines):
        if 'export default function DecisionIntelligenceApp' in line:
            start_idx = i
            break

# 寫入新文件
with open('src/App.jsx', 'w', encoding='utf-8') as f:
    # 寫入新的 imports
    f.write(new_imports)

    # 寫入剩餘部分（從 Mock Data 開始）
    for line in lines[start_idx:]:
        f.write(line)

print("✅ App.jsx 已更新完成！")
print(f"   - 刪除了舊的組件定義")
print(f"   - 添加了新的 import 語句")
print(f"   - 保留了所有業務邏輯")
