import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { Database, Search, Plus, Edit2, Trash2, X, Building2, Upload, FileSpreadsheet } from 'lucide-react';
import { Card, Button, Badge, Modal } from '../components/ui';
import { suppliersService } from '../services/supabaseClient';
import { extractSuppliers, validateFile } from '../utils/dataProcessing';

/**
 * Supplier Management View
 * 供應商管理獨立頁面 - 完整的 CRUD 功能
 */
export const SupplierManagementView = ({ addNotification }) => {
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState([]);
  const [importProgress, setImportProgress] = useState(0);
  const fileInputRef = useRef(null);
  const [formData, setFormData] = useState({
    supplier_name: '',
    contact_info: '',
    address: '',
    product_category: '',
    payment_terms: '',
    delivery_time: ''
  });

  const rowsPerPage = 10;

  // 載入供應商數據
  useEffect(() => {
    loadSuppliers();
  }, []);

  const loadSuppliers = async () => {
    setLoading(true);
    try {
      const data = await suppliersService.getAllSuppliers();
      setSuppliers(data);
    } catch (error) {
      addNotification(`載入失敗: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // 搜索功能
  const handleSearch = async () => {
    if (!searchTerm.trim()) {
      loadSuppliers();
      return;
    }

    setLoading(true);
    try {
      const data = await suppliersService.searchSuppliers(searchTerm);
      setSuppliers(data);
      setCurrentPage(1);
    } catch (error) {
      addNotification(`搜索失敗: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // 新增供應商
  const handleAdd = async () => {
    if (!formData.supplier_name.trim()) {
      addNotification("供應商名稱不能為空", "error");
      return;
    }

    setLoading(true);
    try {
      await suppliersService.insertSuppliers([formData]);
      addNotification("新增成功", "success");
      setShowAddModal(false);
      resetForm();
      loadSuppliers();
    } catch (error) {
      addNotification(`新增失敗: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // 編輯供應商
  const handleEdit = async () => {
    if (!formData.supplier_name.trim()) {
      addNotification("供應商名稱不能為空", "error");
      return;
    }

    setLoading(true);
    try {
      await suppliersService.updateSupplier(selectedSupplier.id, formData);
      addNotification("更新成功", "success");
      setShowEditModal(false);
      resetForm();
      loadSuppliers();
    } catch (error) {
      addNotification(`更新失敗: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // 刪除供應商
  const handleDelete = async () => {
    setLoading(true);
    try {
      await suppliersService.deleteSupplier(selectedSupplier.id);
      addNotification("刪除成功", "success");
      setShowDeleteModal(false);
      setSelectedSupplier(null);
      loadSuppliers();
    } catch (error) {
      addNotification(`刪除失敗: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // Excel 批量匯入
  const handleFileSelect = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const validation = validateFile(file);
    if (!validation.valid) {
      addNotification(validation.errors[0], "error");
      return;
    }

    setImportFile(file);
    setLoading(true);

    try {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const bstr = evt.target.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const data = XLSX.utils.sheet_to_json(wb.Sheets[wsname]);

        // 使用 extractSuppliers 提取供應商數據
        const extractedSuppliers = extractSuppliers(data);

        if (extractedSuppliers.length === 0) {
          addNotification("Excel 文件中未找到有效的供應商數據", "error");
          setLoading(false);
          return;
        }

        setImportPreview(extractedSuppliers);
        setShowImportModal(true);
        addNotification(`已識別 ${extractedSuppliers.length} 個供應商`, "success");
        setLoading(false);
      };
      reader.readAsBinaryString(file);
    } catch (error) {
      addNotification(`文件讀取失敗: ${error.message}`, "error");
      setLoading(false);
    }
  };

  const handleImportConfirm = async () => {
    if (importPreview.length === 0) return;

    setLoading(true);
    setImportProgress(10);

    try {
      // 批量插入供應商
      const { count } = await suppliersService.insertSuppliers(importPreview);

      setImportProgress(100);
      addNotification(`成功匯入 ${count} 個供應商`, "success");
      setShowImportModal(false);
      setImportFile(null);
      setImportPreview([]);
      setImportProgress(0);
      loadSuppliers();
    } catch (error) {
      addNotification(`匯入失敗: ${error.message}`, "error");
      setImportProgress(0);
    } finally {
      setLoading(false);
    }
  };

  const handleImportCancel = () => {
    setShowImportModal(false);
    setImportFile(null);
    setImportPreview([]);
    setImportProgress(0);
  };

  const resetForm = () => {
    setFormData({
      supplier_name: '',
      contact_info: '',
      address: '',
      product_category: '',
      payment_terms: '',
      delivery_time: ''
    });
    setSelectedSupplier(null);
  };

  const openEditModal = (supplier) => {
    setSelectedSupplier(supplier);
    setFormData({
      supplier_name: supplier.supplier_name || '',
      contact_info: supplier.contact_info || '',
      address: supplier.address || '',
      product_category: supplier.product_category || '',
      payment_terms: supplier.payment_terms || '',
      delivery_time: supplier.delivery_time || ''
    });
    setShowEditModal(true);
  };

  const openDeleteModal = (supplier) => {
    setSelectedSupplier(supplier);
    setShowDeleteModal(true);
  };

  // 過濾和分頁
  const filteredSuppliers = searchTerm
    ? suppliers
    : suppliers;

  const totalPages = Math.ceil(filteredSuppliers.length / rowsPerPage);
  const paginatedSuppliers = filteredSuppliers.slice(
    (currentPage - 1) * rowsPerPage,
    currentPage * rowsPerPage
  );

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Building2 className="w-6 h-6 text-purple-500" />
            供應商管理
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            管理所有供應商資料，支持新增、編輯、刪除、批量匯入功能
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx, .xls, .csv"
            onChange={handleFileSelect}
            className="hidden"
          />
          <Button
            variant="secondary"
            icon={Upload}
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
          >
            批量匯入
          </Button>
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => setShowAddModal(true)}
          >
            新增供應商
          </Button>
        </div>
      </div>

      {/* Search and Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <Card className="sm:col-span-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="搜索供應商名稱、聯絡方式或地址..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <Button onClick={handleSearch} disabled={loading}>
              搜索
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setSearchTerm('');
                loadSuppliers();
              }}
            >
              重置
            </Button>
          </div>
        </Card>
        <Card className="text-center">
          <div className="text-2xl font-bold text-purple-600">
            {suppliers.length}
          </div>
          <div className="text-sm text-slate-500 mt-1">總供應商數</div>
        </Card>
      </div>

      {/* Suppliers Table */}
      <Card>
        <div className="overflow-x-auto">
          {loading ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
              <p className="mt-4 text-slate-500">載入中...</p>
            </div>
          ) : paginatedSuppliers.length > 0 ? (
            <>
              <table className="w-full text-sm text-left border-collapse min-w-[800px]">
                <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-700/50">
                  <tr>
                    <th className="px-4 py-3 border-b">#</th>
                    <th className="px-4 py-3 border-b">供應商名稱</th>
                    <th className="px-4 py-3 border-b">聯絡方式</th>
                    <th className="px-4 py-3 border-b">地址</th>
                    <th className="px-4 py-3 border-b">產品類別</th>
                    <th className="px-4 py-3 border-b">付款條件</th>
                    <th className="px-4 py-3 border-b">交貨時間</th>
                    <th className="px-4 py-3 border-b text-center">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedSuppliers.map((supplier, i) => (
                    <tr
                      key={supplier.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors"
                    >
                      <td className="px-4 py-3 border-b text-slate-400 font-mono text-xs">
                        {(currentPage - 1) * rowsPerPage + i + 1}
                      </td>
                      <td className="px-4 py-3 border-b font-semibold">
                        {supplier.supplier_name || '-'}
                      </td>
                      <td className="px-4 py-3 border-b">
                        {supplier.contact_info || '-'}
                      </td>
                      <td className="px-4 py-3 border-b">
                        {supplier.address || '-'}
                      </td>
                      <td className="px-4 py-3 border-b">
                        {supplier.product_category ? (
                          <Badge type="info">{supplier.product_category}</Badge>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="px-4 py-3 border-b">
                        {supplier.payment_terms || '-'}
                      </td>
                      <td className="px-4 py-3 border-b">
                        {supplier.delivery_time || '-'}
                      </td>
                      <td className="px-4 py-3 border-b">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => openEditModal(supplier)}
                            className="p-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition"
                            title="編輯"
                          >
                            <Edit2 className="w-4 h-4 text-blue-600" />
                          </button>
                          <button
                            onClick={() => openDeleteModal(supplier)}
                            className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition"
                            title="刪除"
                          >
                            <Trash2 className="w-4 h-4 text-red-600" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex justify-between items-center mt-4 pt-4 border-t">
                  <div className="text-sm text-slate-500">
                    顯示 {(currentPage - 1) * rowsPerPage + 1} 到{' '}
                    {Math.min(currentPage * rowsPerPage, filteredSuppliers.length)} 筆，
                    共 {filteredSuppliers.length} 筆
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="px-3 py-1 text-sm"
                    >
                      上一頁
                    </Button>
                    <div className="flex items-center gap-1">
                      {[...Array(Math.min(5, totalPages))].map((_, i) => {
                        let pageNum;
                        if (totalPages <= 5) {
                          pageNum = i + 1;
                        } else if (currentPage <= 3) {
                          pageNum = i + 1;
                        } else if (currentPage >= totalPages - 2) {
                          pageNum = totalPages - 4 + i;
                        } else {
                          pageNum = currentPage - 2 + i;
                        }

                        return (
                          <button
                            key={i}
                            onClick={() => setCurrentPage(pageNum)}
                            className={`px-3 py-1 text-sm rounded ${
                              currentPage === pageNum
                                ? 'bg-blue-600 text-white'
                                : 'bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600'
                            }`}
                          >
                            {pageNum}
                          </button>
                        );
                      })}
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1 text-sm"
                    >
                      下一頁
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-12">
              <Database className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                沒有供應商資料
              </h3>
              <p className="text-slate-500 mb-4">
                點擊「新增供應商」按鈕來添加第一個供應商
              </p>
              <Button
                variant="primary"
                icon={Plus}
                onClick={() => setShowAddModal(true)}
              >
                新增供應商
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <Card className="max-w-2xl w-full my-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">新增供應商</h3>
              <button
                onClick={() => {
                  setShowAddModal(false);
                  resetForm();
                }}
                className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  供應商名稱 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.supplier_name}
                  onChange={(e) =>
                    setFormData({ ...formData, supplier_name: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="輸入供應商名稱"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">聯絡方式</label>
                <input
                  type="text"
                  value={formData.contact_info}
                  onChange={(e) =>
                    setFormData({ ...formData, contact_info: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="電話或 Email"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium mb-1">地址</label>
                <input
                  type="text"
                  value={formData.address}
                  onChange={(e) =>
                    setFormData({ ...formData, address: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="輸入地址"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">產品類別</label>
                <input
                  type="text"
                  value={formData.product_category}
                  onChange={(e) =>
                    setFormData({ ...formData, product_category: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="例如：電子零件"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">付款條件</label>
                <input
                  type="text"
                  value={formData.payment_terms}
                  onChange={(e) =>
                    setFormData({ ...formData, payment_terms: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="例如：Net 30"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">交貨時間</label>
                <input
                  type="text"
                  value={formData.delivery_time}
                  onChange={(e) =>
                    setFormData({ ...formData, delivery_time: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="例如：7-14 天"
                />
              </div>
            </div>

            <div className="flex gap-2 justify-end mt-6">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowAddModal(false);
                  resetForm();
                }}
              >
                取消
              </Button>
              <Button variant="primary" onClick={handleAdd} disabled={loading}>
                {loading ? '新增中...' : '確定新增'}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Edit Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <Card className="max-w-2xl w-full my-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">編輯供應商</h3>
              <button
                onClick={() => {
                  setShowEditModal(false);
                  resetForm();
                }}
                className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  供應商名稱 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.supplier_name}
                  onChange={(e) =>
                    setFormData({ ...formData, supplier_name: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">聯絡方式</label>
                <input
                  type="text"
                  value={formData.contact_info}
                  onChange={(e) =>
                    setFormData({ ...formData, contact_info: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium mb-1">地址</label>
                <input
                  type="text"
                  value={formData.address}
                  onChange={(e) =>
                    setFormData({ ...formData, address: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">產品類別</label>
                <input
                  type="text"
                  value={formData.product_category}
                  onChange={(e) =>
                    setFormData({ ...formData, product_category: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">付款條件</label>
                <input
                  type="text"
                  value={formData.payment_terms}
                  onChange={(e) =>
                    setFormData({ ...formData, payment_terms: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">交貨時間</label>
                <input
                  type="text"
                  value={formData.delivery_time}
                  onChange={(e) =>
                    setFormData({ ...formData, delivery_time: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
            </div>

            <div className="flex gap-2 justify-end mt-6">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowEditModal(false);
                  resetForm();
                }}
              >
                取消
              </Button>
              <Button variant="primary" onClick={handleEdit} disabled={loading}>
                {loading ? '更新中...' : '確定更新'}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="bg-green-100 dark:bg-green-900/30 p-2 rounded-lg">
                  <FileSpreadsheet className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">批量匯入供應商</h3>
                  <p className="text-sm text-slate-500">
                    預覽將要匯入的 {importPreview.length} 個供應商
                  </p>
                </div>
              </div>
              <button
                onClick={handleImportCancel}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Preview Table */}
            <div className="mb-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800">
                  <tr>
                    <th className="px-4 py-2 text-left">#</th>
                    <th className="px-4 py-2 text-left">供應商名稱</th>
                    <th className="px-4 py-2 text-left">聯絡方式</th>
                    <th className="px-4 py-2 text-left">地址</th>
                    <th className="px-4 py-2 text-left">產品類別</th>
                  </tr>
                </thead>
                <tbody>
                  {importPreview.map((supplier, idx) => (
                    <tr key={idx} className="border-b border-slate-200 dark:border-slate-700">
                      <td className="px-4 py-2">{idx + 1}</td>
                      <td className="px-4 py-2 font-medium">{supplier.supplier_name}</td>
                      <td className="px-4 py-2">{supplier.contact_info || '-'}</td>
                      <td className="px-4 py-2">{supplier.address || '-'}</td>
                      <td className="px-4 py-2">{supplier.product_category || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Progress Bar */}
            {importProgress > 0 && (
              <div className="mb-4">
                <div className="bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                  <div
                    className="bg-green-600 h-2 rounded-full transition-all"
                    style={{ width: `${importProgress}%` }}
                  />
                </div>
                <p className="text-sm text-slate-500 mt-1 text-center">
                  匯入進度: {importProgress}%
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 justify-end">
              <Button
                variant="secondary"
                onClick={handleImportCancel}
                disabled={importProgress > 0 && importProgress < 100}
              >
                取消
              </Button>
              <Button
                variant="success"
                icon={Upload}
                onClick={handleImportConfirm}
                disabled={importProgress > 0 && importProgress < 100}
              >
                確定匯入 {importPreview.length} 個供應商
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Delete Modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          setSelectedSupplier(null);
        }}
        onConfirm={handleDelete}
        title="刪除供應商?"
        description="此操作無法撤銷"
        icon={Trash2}
        iconBgColor="bg-red-100 dark:bg-red-900/30"
        iconColor="text-red-600"
        confirmText="確定刪除"
        confirmVariant="danger"
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          確定要刪除供應商「{selectedSupplier?.supplier_name}」嗎？
        </p>
      </Modal>
    </div>
  );
};

export default SupplierManagementView;
