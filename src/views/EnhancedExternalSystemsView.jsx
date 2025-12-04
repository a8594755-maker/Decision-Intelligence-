/**
 * Enhanced External Systems View
 * 增强版外部系统数据上传 - 支持多类型上传、字段映射、数据验证
 */

import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  Database, Upload, Download, X, RefreshCw, Sparkles,
  Check, AlertTriangle, ArrowRight, ArrowLeft, FileSpreadsheet
} from 'lucide-react';
import { Card, Button } from '../components/ui';
import { callGeminiAPI } from '../services/geminiAPI';
import {
  suppliersService,
  materialsService,
  goodsReceiptsService,
  priceHistoryService,
  userFilesService
} from '../services/supabaseClient';
import {
  batchValidateAndClean,
  suggestFieldMapping
} from '../utils/dataCleaningUtils';

// 上传类型配置
const UPLOAD_TYPES = {
  goods_receipt: {
    label: '收货记录 (Goods Receipt)',
    description: '用于计算不良率和准时率',
    icon: '📦',
    requiredFields: ['supplier_name', 'material_code', 'actual_delivery_date', 'received_qty'],
    optionalFields: [
      'supplier_code', 'material_name', 'po_number', 'receipt_number',
      'planned_delivery_date', 'receipt_date', 'rejected_qty', 'category', 'uom'
    ]
  },
  price_history: {
    label: '价格历史 (Price History)',
    description: '用于计算价格波动度',
    icon: '💰',
    requiredFields: ['supplier_name', 'material_code', 'order_date', 'unit_price'],
    optionalFields: [
      'supplier_code', 'material_name', 'currency', 'quantity', 'is_contract_price'
    ]
  },
  supplier_master: {
    label: '供应商主档 (Supplier Master)',
    description: '创建或更新供应商信息',
    icon: '🏢',
    requiredFields: ['supplier_name'],
    optionalFields: [
      'supplier_code', 'contact_person', 'phone', 'email',
      'address', 'product_category', 'payment_terms', 'delivery_time', 'status'
    ]
  }
};

const EnhancedExternalSystemsView = ({ addNotification, user }) => {
  // 多步骤流程状态
  const [currentStep, setCurrentStep] = useState(1); // 1: 选择类型, 2: 上传, 3: 映射, 4: 验证, 5: 保存

  // 数据类型
  const [uploadType, setUploadType] = useState(null);

  // 文件和数据
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState('');
  const [rawRows, setRawRows] = useState([]);
  const [columns, setColumns] = useState([]);

  // 字段映射
  const [fieldMapping, setFieldMapping] = useState({});
  const [aiSuggestions, setAiSuggestions] = useState({});
  const [mappingComplete, setMappingComplete] = useState(false);

  // 验证结果
  const [validationResult, setValidationResult] = useState(null);

  // UI 状态
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [saving, setSaving] = useState(false);

  const fileInputRef = useRef(null);

  // Step 1: 选择上传类型
  const handleTypeSelect = (type) => {
    setUploadType(type);
    setCurrentStep(2);
    // 重置其他状态
    setFile(null);
    setFileName('');
    setRawRows([]);
    setColumns([]);
    setFieldMapping({});
    setValidationResult(null);
  };

  // Step 2: 上传文件
  const handleFileChange = async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    const lower = selectedFile.name.toLowerCase();
    const isExcel = lower.endsWith('.xlsx') || lower.endsWith('.xls');
    const isCsv = lower.endsWith('.csv');

    if (!isExcel && !isCsv) {
      addNotification("Invalid file type. Please upload CSV or Excel files (.csv, .xlsx, .xls)", "error");
      return;
    }

    if (selectedFile.size > 10 * 1024 * 1024) {
      addNotification("File too large. Maximum size is 10MB", "error");
      return;
    }

    setFile(selectedFile);
    setFileName(selectedFile.name);
    setUploadProgress(10);
    setLoading(true);

    try {
      const rows = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const bstr = evt.target.result;
            const wb = XLSX.read(bstr, { type: 'binary' });
            const wsname = wb.SheetNames[0];
            const data = XLSX.utils.sheet_to_json(wb.Sheets[wsname], { defval: '' });
            resolve(data);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = reject;
        reader.readAsBinaryString(selectedFile);
      });

      if (rows.length === 0) {
        throw new Error('文件为空');
      }

      const cols = Object.keys(rows[0]);
      setRawRows(rows);
      setColumns(cols);
      setUploadProgress(100);

      addNotification(`已载入 ${rows.length} 行数据`, "success");

      // 自动进入字段映射步骤
      setTimeout(() => {
        setCurrentStep(3);
        generateFieldMappingSuggestions(cols);
      }, 500);

    } catch (error) {
      addNotification(`Upload failed: ${error.message}`, "error");
      setFile(null);
      setFileName('');
      setRawRows([]);
    } finally {
      setLoading(false);
      setTimeout(() => setUploadProgress(0), 1000);
    }
  };

  // Step 3: 生成字段映射建议
  const generateFieldMappingSuggestions = (cols) => {
    const typeConfig = UPLOAD_TYPES[uploadType];
    if (!typeConfig) return;

    const systemFields = [...typeConfig.requiredFields, ...typeConfig.optionalFields];

    // 使用工具函数生成建议
    const suggestions = suggestFieldMapping(cols, systemFields, uploadType);

    setAiSuggestions(suggestions);
    setFieldMapping(suggestions);

    // 检查必填字段是否都已映射
    checkMappingComplete(suggestions);
  };

  // AI 辅助字段映射（可选增强）
  const enhanceMappingWithAI = async () => {
    if (!rawRows || rawRows.length === 0) return;

    try {
      setLoading(true);
      const sample = rawRows.slice(0, 5);
      const typeConfig = UPLOAD_TYPES[uploadType];
      const systemFields = [...typeConfig.requiredFields, ...typeConfig.optionalFields];

      const prompt = `你是一个字段映射专家。请将 Excel 列名映射到系统字段。

Excel 列名: ${columns.join(', ')}

系统字段（必填）: ${typeConfig.requiredFields.join(', ')}
系统字段（可选）: ${typeConfig.optionalFields.join(', ')}

示例数据:
${JSON.stringify(sample.slice(0, 3), null, 2)}

请返回 JSON 格式的映射关系，如: {"系统字段": "Excel列名", ...}
只映射你确定的字段，不确定的不要映射。`;

      const aiText = await callGeminiAPI(prompt);

      // 尝试提取 JSON
      const match = aiText.match(/\{[\s\S]*\}/);
      if (match) {
        const aiMapping = JSON.parse(match[0]);

        // 合并 AI 建议和现有映射
        const mergedMapping = { ...fieldMapping, ...aiMapping };
        setFieldMapping(mergedMapping);
        setAiSuggestions(mergedMapping);
        checkMappingComplete(mergedMapping);

        addNotification("AI 建议已应用", "success");
      }
    } catch (error) {
      addNotification(`AI 分析失败: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // 更新字段映射
  const updateFieldMapping = (systemField, excelColumn) => {
    const updated = { ...fieldMapping, [systemField]: excelColumn };
    setFieldMapping(updated);
    checkMappingComplete(updated);
  };

  // 检查映射是否完成
  const checkMappingComplete = (mapping) => {
    const typeConfig = UPLOAD_TYPES[uploadType];
    const allRequiredMapped = typeConfig.requiredFields.every(field => mapping[field]);
    setMappingComplete(allRequiredMapped);
  };

  // Step 4: 验证数据
  const validateData = () => {
    if (!mappingComplete) {
      addNotification("请先完成必填字段映射", "error");
      return;
    }

    setLoading(true);

    try {
      const result = batchValidateAndClean(rawRows, uploadType, fieldMapping);
      setValidationResult(result);
      setCurrentStep(4);

      if (result.stats.successRate < 50) {
        addNotification(`警告: 只有 ${result.stats.successRate}% 的数据有效`, "warning");
      } else {
        addNotification(`验证完成: ${result.stats.valid}/${result.stats.total} 行有效`, "success");
      }
    } catch (error) {
      addNotification(`验证失败: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // Step 5: 保存数据
  const handleSave = async () => {
    if (!validationResult || validationResult.validRows.length === 0) {
      addNotification("没有有效数据可保存", "error");
      return;
    }

    setSaving(true);

    try {
      const userId = user?.id;
      if (!userId) {
        throw new Error('用户未登录');
      }

      // 1. 保存原始文件记录
      const fileRecord = await userFilesService.saveFile(userId, fileName, rawRows);
      const uploadFileId = fileRecord.id;

      // 2. 根据类型处理数据
      if (uploadType === 'goods_receipt') {
        await saveGoodsReceipts(userId, validationResult.validRows, uploadFileId);
      } else if (uploadType === 'price_history') {
        await savePriceHistory(userId, validationResult.validRows, uploadFileId);
      } else if (uploadType === 'supplier_master') {
        await saveSuppliers(userId, validationResult.validRows);
      }

      addNotification(`成功保存 ${validationResult.validRows.length} 条记录`, "success");

      // 重置流程
      setTimeout(() => {
        resetFlow();
      }, 1500);

    } catch (error) {
      addNotification(`保存失败: ${error.message}`, "error");
    } finally {
      setSaving(false);
    }
  };

  // 保存收货记录
  const saveGoodsReceipts = async (userId, validRows, uploadFileId) => {
    const receipts = [];

    for (const row of validRows) {
      // 1. 创建或获取供应商
      const supplier = await suppliersService.findOrCreate(userId, {
        supplier_name: row.supplier_name,
        supplier_code: row.supplier_code || null
      });

      // 2. 创建或获取物料
      const material = await materialsService.findOrCreate(userId, {
        material_code: row.material_code,
        material_name: row.material_name || row.material_code,
        category: row.category || null,
        uom: row.uom || 'pcs'
      });

      // 3. 构建收货记录
      receipts.push({
        supplier_id: supplier.id,
        material_id: material.id,
        po_number: row.po_number,
        receipt_number: row.receipt_number,
        planned_delivery_date: row.planned_delivery_date,
        actual_delivery_date: row.actual_delivery_date,
        receipt_date: row.receipt_date,
        received_qty: row.received_qty,
        rejected_qty: row.rejected_qty || 0
      });
    }

    // 批量插入
    await goodsReceiptsService.batchInsert(userId, receipts, uploadFileId);
  };

  // 保存价格历史
  const savePriceHistory = async (userId, validRows, uploadFileId) => {
    const prices = [];

    for (const row of validRows) {
      const supplier = await suppliersService.findOrCreate(userId, {
        supplier_name: row.supplier_name,
        supplier_code: row.supplier_code || null
      });

      const material = await materialsService.findOrCreate(userId, {
        material_code: row.material_code,
        material_name: row.material_name || row.material_code
      });

      prices.push({
        supplier_id: supplier.id,
        material_id: material.id,
        order_date: row.order_date,
        unit_price: row.unit_price,
        currency: row.currency || 'USD',
        quantity: row.quantity || 0,
        is_contract_price: row.is_contract_price || false
      });
    }

    await priceHistoryService.batchInsert(userId, prices, uploadFileId);
  };

  // 保存供应商
  const saveSuppliers = async (userId, validRows) => {
    const suppliers = validRows.map(row => ({
      user_id: userId,
      supplier_name: row.supplier_name,
      supplier_code: row.supplier_code || null,
      contact_info: {
        contact_person: row.contact_person,
        phone: row.phone,
        email: row.email
      },
      address: row.address,
      product_category: row.product_category,
      payment_terms: row.payment_terms,
      delivery_time: row.delivery_time,
      status: row.status || 'active'
    }));

    await suppliersService.insertSuppliers(suppliers);
  };

  // 重置流程
  const resetFlow = () => {
    setCurrentStep(1);
    setUploadType(null);
    setFile(null);
    setFileName('');
    setRawRows([]);
    setColumns([]);
    setFieldMapping({});
    setAiSuggestions({});
    setValidationResult(null);
    setMappingComplete(false);
  };

  // 返回上一步
  const goBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  // ========== 渲染部分 ==========

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Database className="w-6 h-6 text-blue-500" />
            数据上传 - {uploadType ? UPLOAD_TYPES[uploadType].label : '选择类型'}
          </h2>
          {fileName && (
            <p className="text-sm text-slate-500 mt-1">文件: {fileName}</p>
          )}
        </div>

        {currentStep > 1 && (
          <Button onClick={resetFlow} variant="secondary" icon={X}>
            取消
          </Button>
        )}
      </div>

      {/* Progress Steps */}
      {currentStep > 1 && (
        <div className="flex items-center justify-between mb-6">
          {['选择类型', '上传文件', '字段映射', '数据验证', '保存'].map((step, index) => (
            <div key={step} className="flex items-center">
              <div className={`flex items-center justify-center w-8 h-8 rounded-full ${
                index + 1 < currentStep ? 'bg-green-500 text-white' :
                index + 1 === currentStep ? 'bg-blue-500 text-white' :
                'bg-slate-300 text-slate-600'
              }`}>
                {index + 1 < currentStep ? <Check className="w-5 h-5" /> : index + 1}
              </div>
              {index < 4 && (
                <div className={`w-12 md:w-24 h-1 mx-2 ${
                  index + 1 < currentStep ? 'bg-green-500' : 'bg-slate-300'
                }`} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Step 1: 选择上传类型 */}
      {currentStep === 1 && (
        <div className="grid md:grid-cols-3 gap-4">
          {Object.entries(UPLOAD_TYPES).map(([key, config]) => (
            <Card
              key={key}
              className="cursor-pointer hover:border-blue-500 transition-all hover:shadow-lg"
              onClick={() => handleTypeSelect(key)}
            >
              <div className="text-center space-y-3">
                <div className="text-5xl">{config.icon}</div>
                <h3 className="font-semibold text-lg">{config.label}</h3>
                <p className="text-sm text-slate-600 dark:text-slate-400">{config.description}</p>
                <div className="text-xs text-slate-500">
                  <p className="font-medium">必填字段:</p>
                  <p className="text-xs mt-1">{config.requiredFields.join(', ')}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Step 2: 上传文件 */}
      {currentStep === 2 && (
        <Card>
          <div className="space-y-4">
            <h3 className="font-semibold flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5" />
              上传 Excel 或 CSV 文件
            </h3>

            <div className="border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-lg p-8 text-center">
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx, .xls, .csv"
                onChange={handleFileChange}
                className="hidden"
              />
              <Upload className="w-12 h-12 mx-auto mb-4 text-slate-400" />
              <Button onClick={() => fileInputRef.current?.click()} disabled={loading}>
                {loading ? '加载中...' : '选择文件'}
              </Button>
              <p className="text-sm text-slate-500 mt-2">支持 .xlsx, .xls, .csv 格式，最大 10MB</p>
            </div>

            {uploadProgress > 0 && uploadProgress < 100 && (
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span>上传进度</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            <div className="flex justify-between">
              <Button onClick={goBack} variant="secondary" icon={ArrowLeft}>
                返回
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Step 3: 字段映射 */}
      {currentStep === 3 && rawRows.length > 0 && (
        <Card>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-semibold flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-blue-500" />
                字段映射
              </h3>
              <Button onClick={enhanceMappingWithAI} variant="secondary" disabled={loading}>
                {loading ? 'AI 分析中...' : 'AI 智能建议'}
              </Button>
            </div>

            <p className="text-sm text-slate-600 dark:text-slate-400">
              将 Excel 列名映射到系统字段。带 <span className="text-red-500">*</span> 的字段为必填。
            </p>

            <div className="space-y-3 max-h-96 overflow-y-auto">
              {UPLOAD_TYPES[uploadType].requiredFields.map(field => (
                <div key={field} className="flex items-center gap-3">
                  <label className="w-48 text-sm font-medium flex items-center gap-1">
                    {field}
                    <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={fieldMapping[field] || ''}
                    onChange={(e) => updateFieldMapping(field, e.target.value)}
                    className="flex-1 px-3 py-2 border rounded-lg dark:bg-slate-800 dark:border-slate-700"
                  >
                    <option value="">-- 选择 Excel 列 --</option>
                    {columns.map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>
              ))}

              <hr className="my-4" />

              {UPLOAD_TYPES[uploadType].optionalFields.map(field => (
                <div key={field} className="flex items-center gap-3">
                  <label className="w-48 text-sm font-medium text-slate-600 dark:text-slate-400">
                    {field}
                  </label>
                  <select
                    value={fieldMapping[field] || ''}
                    onChange={(e) => updateFieldMapping(field, e.target.value)}
                    className="flex-1 px-3 py-2 border rounded-lg dark:bg-slate-800 dark:border-slate-700"
                  >
                    <option value="">-- 可选 --</option>
                    {columns.map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {/* 数据预览 */}
            <div className="mt-4 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
              <h4 className="text-sm font-medium mb-2">数据预览 (前3行)</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b dark:border-slate-700">
                      {columns.slice(0, 5).map(col => (
                        <th key={col} className="text-left p-2">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rawRows.slice(0, 3).map((row, idx) => (
                      <tr key={idx} className="border-b dark:border-slate-700">
                        {columns.slice(0, 5).map(col => (
                          <td key={col} className="p-2">{String(row[col]).substring(0, 20)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-between">
              <Button onClick={goBack} variant="secondary" icon={ArrowLeft}>
                返回
              </Button>
              <Button
                onClick={validateData}
                disabled={!mappingComplete || loading}
                icon={ArrowRight}
              >
                下一步: 验证数据
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Step 4: 数据验证 */}
      {currentStep === 4 && validationResult && (
        <Card>
          <div className="space-y-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Check className="w-5 h-5 text-green-500" />
              数据验证结果
            </h3>

            {/* 统计信息 */}
            <div className="grid md:grid-cols-4 gap-4">
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <div className="text-2xl font-bold">{validationResult.stats.total}</div>
                <div className="text-sm text-slate-600 dark:text-slate-400">总行数</div>
              </div>
              <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
                <div className="text-2xl font-bold text-green-600">{validationResult.stats.valid}</div>
                <div className="text-sm text-slate-600 dark:text-slate-400">有效行数</div>
              </div>
              <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
                <div className="text-2xl font-bold text-red-600">{validationResult.stats.invalid}</div>
                <div className="text-sm text-slate-600 dark:text-slate-400">无效行数</div>
              </div>
              <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                <div className="text-2xl font-bold text-purple-600">{validationResult.stats.successRate}%</div>
                <div className="text-sm text-slate-600 dark:text-slate-400">成功率</div>
              </div>
            </div>

            {/* 错误列表 */}
            {validationResult.invalidRows.length > 0 && (
              <div className="max-h-64 overflow-y-auto">
                <h4 className="font-medium text-red-600 mb-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  错误详情 (显示前 10 条)
                </h4>
                <div className="space-y-2">
                  {validationResult.invalidRows.slice(0, 10).map((item, idx) => (
                    <div key={idx} className="p-2 bg-red-50 dark:bg-red-900/20 rounded text-sm">
                      <div className="font-medium">第 {item.rowIndex} 行:</div>
                      <ul className="list-disc list-inside text-xs text-red-700 dark:text-red-400">
                        {item.errors.map((err, i) => (
                          <li key={i}>{err}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-between">
              <Button onClick={goBack} variant="secondary" icon={ArrowLeft}>
                返回修改
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || validationResult.validRows.length === 0}
                variant="success"
                icon={Check}
              >
                {saving ? '保存中...' : `保存 ${validationResult.validRows.length} 条有效记录`}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default EnhancedExternalSystemsView;
