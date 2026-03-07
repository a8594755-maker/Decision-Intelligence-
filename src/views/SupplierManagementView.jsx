import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { Database, Search, Plus, Edit2, Trash2, X, Building2, Upload, FileSpreadsheet, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';
import { Card, Button, Badge, Modal } from '../components/ui';
import { suppliersService } from '../services/supabaseClient';
import { extractSuppliers, validateFile } from '../utils/dataProcessing';
import { getSupplierKpiSummary } from '../services/supplierKpiService';
import { useAuth } from '../contexts/AuthContext';

/**
 * Supplier Management View
 * Standalone supplier management page with full CRUD functionality
 */
export const SupplierManagementView = ({ addNotification }) => {
  const { user } = useAuth();
  const [suppliers, setSuppliers] = useState([]);
  const [suppliersWithKpi, setSuppliersWithKpi] = useState([]);
  const [loading, setLoading] = useState(false);
  const [_loadingKpi, setLoadingKpi] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [_importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState([]);
  const [importProgress, setImportProgress] = useState(0);
  const fileInputRef = useRef(null);
  const [formData, setFormData] = useState({
    supplier_name: '',
    supplier_code: '',
    contact_info: '',
    address: '',
    product_category: '',
    payment_terms: '',
    delivery_time: ''
  });

  const rowsPerPage = 10;

  // Helper function to format contact_info object
  const formatContactInfo = (contactInfo) => {
    if (!contactInfo) return '-';
    if (typeof contactInfo === 'string') return contactInfo;

    const parts = [];
    if (contactInfo.contact_person) parts.push(contactInfo.contact_person);
    if (contactInfo.phone) parts.push(contactInfo.phone);
    if (contactInfo.email) parts.push(contactInfo.email);

    return parts.length > 0 ? parts.join(' | ') : '-';
  };

  // Load supplier data
  useEffect(() => {
    if (user?.id) {
      loadSuppliers();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const loadSuppliers = async () => {
    if (!user?.id) return;

    setLoading(true);
    try {
      const data = await suppliersService.getAllSuppliers(user.id);
      
      // 去重：合併相同 supplier_name 的記錄，保留最完整的資訊
      const deduplicatedData = deduplicateSuppliers(data);
      
      setSuppliers(deduplicatedData);

      // Load KPI data
      if (deduplicatedData && deduplicatedData.length > 0) {
        loadKpiData(user.id, deduplicatedData);
      }
    } catch (error) {
      addNotification(`Load failed: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // 去重函數：合併相同供應商，保留最完整的資訊
  const deduplicateSuppliers = (suppliers) => {
    if (!suppliers || suppliers.length === 0) return [];

    const supplierMap = new Map();

    suppliers.forEach(supplier => {
      const key = supplier.supplier_name?.trim().toLowerCase();
      if (!key) return;

      const existing = supplierMap.get(key);

      if (!existing) {
        // 第一次出現，直接添加
        supplierMap.set(key, supplier);
      } else {
        // 已存在，合併資訊（保留最完整的）
        const merged = { ...existing };

        // 合併 contact_info
        if (supplier.contact_info && typeof supplier.contact_info === 'object') {
          merged.contact_info = { ...existing.contact_info };
          Object.keys(supplier.contact_info).forEach(key => {
            const existingValue = merged.contact_info[key];
            const newValue = supplier.contact_info[key];
            
            // 如果現有值為空，使用新值
            if (!existingValue || existingValue === '-' || existingValue === '') {
              if (newValue && newValue !== '-' && newValue !== '') {
                merged.contact_info[key] = newValue;
              }
            }
          });
        }

        // 合併其他欄位
        ['supplier_code', 'address', 'product_category', 'payment_terms', 'delivery_time', 'status'].forEach(field => {
          const existingValue = merged[field];
          const newValue = supplier[field];
          
          if (!existingValue || existingValue === '-' || existingValue === '') {
            if (newValue && newValue !== '-' && newValue !== '') {
              merged[field] = newValue;
            }
          }
        });

        // 保留最新的 updated_at
        if (supplier.updated_at && (!merged.updated_at || supplier.updated_at > merged.updated_at)) {
          merged.updated_at = supplier.updated_at;
        }

        supplierMap.set(key, merged);
      }
    });

    return Array.from(supplierMap.values());
  };

  const loadKpiData = async (userId, supplierList = suppliers) => {
    setLoadingKpi(true);
    try {
      const kpiData = await getSupplierKpiSummary(userId);

      // Merge KPI data with suppliers
      const merged = supplierList.map(supplier => {
        const kpi = Array.isArray(kpiData)
          ? kpiData.find(k => k.supplier_id === supplier.id)
          : null;

        return {
          ...supplier,
          kpi: kpi || {
            defect_rate: 0,
            on_time_rate: 0,
            max_price_volatility: 0,
            overall_score: 0,
            risk_level: 'unknown'
          }
        };
      });

      setSuppliersWithKpi(merged);
    } catch (error) {
      console.error('Failed to load KPI data:', error);
      // Fallback: use suppliers without KPI
      setSuppliersWithKpi(supplierList.map(s => ({
        ...s,
        kpi: {
          defect_rate: 0,
          on_time_rate: 0,
          max_price_volatility: 0,
          overall_score: 0,
          risk_level: 'unknown'
        }
      })));
    } finally {
      setLoadingKpi(false);
    }
  };

  // Search functionality
  const handleSearch = async () => {
    if (!user?.id) return;

    if (!searchTerm.trim()) {
      loadSuppliers();
      return;
    }

    setLoading(true);
    try {
      const data = await suppliersService.searchSuppliers(user.id, searchTerm);
      setSuppliers(data);
      setCurrentPage(1);
    } catch (error) {
      addNotification(`Search failed: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // Add supplier
  const handleAdd = async () => {
    if (!user?.id) return;

    if (!formData.supplier_name.trim()) {
      addNotification("Supplier name cannot be empty", "error");
      return;
    }

    setLoading(true);
    try {
      const supplierData = {
        supplier_name: formData.supplier_name,
        supplier_code: formData.supplier_code || null,
        contact_info: {
          contact_person: formData.contact_info,
          address: formData.address,
          product_category: formData.product_category,
          payment_terms: formData.payment_terms,
          delivery_time: formData.delivery_time
        },
        status: 'active'
      };
      await suppliersService.insertSuppliers(user.id, [supplierData]);
      addNotification("Supplier added successfully", "success");
      setShowAddModal(false);
      resetForm();
      loadSuppliers();
    } catch (error) {
      addNotification(`Add failed: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // Edit supplier
  const handleEdit = async () => {
    if (!user?.id) return;

    if (!formData.supplier_name.trim()) {
      addNotification("Supplier name cannot be empty", "error");
      return;
    }

    setLoading(true);
    try {
      const supplierData = {
        supplier_name: formData.supplier_name,
        supplier_code: formData.supplier_code || null,
        contact_info: {
          contact_person: formData.contact_info,
          address: formData.address,
          product_category: formData.product_category,
          payment_terms: formData.payment_terms,
          delivery_time: formData.delivery_time
        }
      };
      await suppliersService.updateSupplier(user.id, selectedSupplier.id, supplierData);
      addNotification("Supplier updated successfully", "success");
      setShowEditModal(false);
      resetForm();
      loadSuppliers();
    } catch (error) {
      addNotification(`Update failed: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // Delete supplier
  const handleDelete = async () => {
    if (!user?.id) return;

    setLoading(true);
    try {
      await suppliersService.deleteSupplier(user.id, selectedSupplier.id);
      addNotification("Supplier deleted successfully", "success");
      setShowDeleteModal(false);
      setSelectedSupplier(null);
      loadSuppliers();
    } catch (error) {
      addNotification(`Delete failed: ${error.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // Excel bulk import
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

        // Extract supplier data using extractSuppliers
        const extractedSuppliers = extractSuppliers(data);

        if (extractedSuppliers.length === 0) {
          addNotification("No valid supplier data found in Excel file", "error");
          setLoading(false);
          return;
        }

        setImportPreview(extractedSuppliers);
        setShowImportModal(true);
        addNotification(`Identified ${extractedSuppliers.length} suppliers`, "success");
        setLoading(false);
      };
      reader.readAsBinaryString(file);
    } catch (error) {
      addNotification(`File read failed: ${error.message}`, "error");
      setLoading(false);
    }
  };

  const handleImportConfirm = async () => {
    if (!user?.id) return;

    if (importPreview.length === 0) return;

    setLoading(true);
    setImportProgress(10);

    try {
      // Batch insert suppliers
      const { count } = await suppliersService.insertSuppliers(user.id, importPreview);

      setImportProgress(100);
      addNotification(`Successfully imported ${count} suppliers`, "success");
      setShowImportModal(false);
      setImportFile(null);
      setImportPreview([]);
      setImportProgress(0);
      loadSuppliers();
    } catch (error) {
      addNotification(`Import failed: ${error.message}`, "error");
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
      supplier_code: '',
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
    const contactInfo = supplier.contact_info || {};
    setFormData({
      supplier_name: supplier.supplier_name || '',
      supplier_code: supplier.supplier_code || '',
      contact_info: typeof contactInfo === 'string' ? contactInfo : (contactInfo.contact_person || contactInfo.phone || contactInfo.email || ''),
      address: typeof contactInfo === 'object' ? (contactInfo.address || '') : '',
      product_category: typeof contactInfo === 'object' ? (contactInfo.product_category || '') : '',
      payment_terms: typeof contactInfo === 'object' ? (contactInfo.payment_terms || '') : '',
      delivery_time: typeof contactInfo === 'object' ? (contactInfo.delivery_time || '') : ''
    });
    setShowEditModal(true);
  };

  const openDeleteModal = (supplier) => {
    setSelectedSupplier(supplier);
    setShowDeleteModal(true);
  };

  // Filtering and pagination
  const displaySuppliers = suppliersWithKpi.length > 0 ? suppliersWithKpi : suppliers;
  const filteredSuppliers = searchTerm
    ? displaySuppliers
    : displaySuppliers;

  const totalPages = Math.ceil(filteredSuppliers.length / rowsPerPage);
  const paginatedSuppliers = filteredSuppliers.slice(
    (currentPage - 1) * rowsPerPage,
    currentPage * rowsPerPage
  );

  // Helper function to get risk badge
  const getRiskBadge = (riskLevel) => {
    switch (riskLevel) {
      case 'low':
        return <Badge type="success">Low Risk</Badge>;
      case 'medium':
        return <Badge type="warning">Medium Risk</Badge>;
      case 'high':
        return <Badge type="danger">High Risk</Badge>;
      default:
        return <Badge type="info">No Data</Badge>;
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Building2 className="w-6 h-6 text-purple-500" />
            Supplier Management
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Manage all supplier information with add, edit, delete, and bulk import functionality
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
            Bulk Import
          </Button>
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => setShowAddModal(true)}
          >
            Add Supplier
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
                placeholder="Search supplier name, contact, or address..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <Button onClick={handleSearch} disabled={loading}>
              Search
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setSearchTerm('');
                loadSuppliers();
              }}
            >
              Reset
            </Button>
          </div>
        </Card>
        <Card className="text-center">
          <div className="text-2xl font-bold text-purple-600">
            {suppliers.length}
          </div>
          <div className="text-sm text-slate-500 mt-1">Total Suppliers</div>
        </Card>
      </div>

      {/* Suppliers Table */}
      <Card>
        <div className="overflow-x-auto">
          {loading ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
              <p className="mt-4 text-slate-500">Loading...</p>
            </div>
          ) : paginatedSuppliers.length > 0 ? (
            <>
              <table className="w-full text-sm text-left border-collapse min-w-[1200px]">
                <thead className="text-xs uppercase bg-slate-50 dark:bg-slate-700/50">
                  <tr>
                    <th className="px-4 py-3 border-b">#</th>
                    <th className="px-4 py-3 border-b">Supplier Name</th>
                    <th className="px-4 py-3 border-b">Contact Info</th>
                    <th className="px-4 py-3 border-b">Product Category</th>
                    <th className="px-4 py-3 border-b text-center" title="Defect Rate">
                      <div className="flex items-center justify-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Defect %
                      </div>
                    </th>
                    <th className="px-4 py-3 border-b text-center" title="On-Time Delivery Rate">
                      <div className="flex items-center justify-center gap-1">
                        <TrendingUp className="w-3 h-3" />
                        On-Time %
                      </div>
                    </th>
                    <th className="px-4 py-3 border-b text-center" title="Price Volatility">
                      <div className="flex items-center justify-center gap-1">
                        <TrendingDown className="w-3 h-3" />
                        Volatility %
                      </div>
                    </th>
                    <th className="px-4 py-3 border-b text-center">Score</th>
                    <th className="px-4 py-3 border-b text-center">Risk</th>
                    <th className="px-4 py-3 border-b text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedSuppliers.map((supplier, i) => {
                    const kpi = supplier.kpi || {};
                    const hasKpiData = kpi.risk_level && kpi.risk_level !== 'unknown';

                    return (
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
                        <td className="px-4 py-3 border-b text-xs">
                          {formatContactInfo(supplier.contact_info)}
                        </td>
                        <td className="px-4 py-3 border-b">
                          {supplier.contact_info?.product_category ? (
                            <Badge type="info">{supplier.contact_info.product_category}</Badge>
                          ) : (
                            '-'
                          )}
                        </td>

                        {/* KPI Columns */}
                        <td className="px-4 py-3 border-b text-center">
                          {hasKpiData ? (
                            <span className={`font-semibold ${
                              kpi.defect_rate > 5 ? 'text-red-600' :
                              kpi.defect_rate > 2 ? 'text-yellow-600' :
                              'text-green-600'
                            }`}>
                              {kpi.defect_rate?.toFixed(2)}%
                            </span>
                          ) : (
                            <span className="text-slate-400 text-xs">-</span>
                          )}
                        </td>

                        <td className="px-4 py-3 border-b text-center">
                          {hasKpiData ? (
                            <span className={`font-semibold ${
                              kpi.on_time_rate < 90 ? 'text-red-600' :
                              kpi.on_time_rate < 95 ? 'text-yellow-600' :
                              'text-green-600'
                            }`}>
                              {kpi.on_time_rate?.toFixed(2)}%
                            </span>
                          ) : (
                            <span className="text-slate-400 text-xs">-</span>
                          )}
                        </td>

                        <td className="px-4 py-3 border-b text-center">
                          {hasKpiData ? (
                            <span className={`font-semibold ${
                              kpi.max_price_volatility > 15 ? 'text-red-600' :
                              kpi.max_price_volatility > 10 ? 'text-yellow-600' :
                              'text-green-600'
                            }`}>
                              {kpi.max_price_volatility?.toFixed(2)}%
                            </span>
                          ) : (
                            <span className="text-slate-400 text-xs">-</span>
                          )}
                        </td>

                        <td className="px-4 py-3 border-b text-center">
                          {hasKpiData ? (
                            <div className="flex items-center justify-center gap-1">
                              <span className={`font-bold text-lg ${
                                kpi.overall_score >= 90 ? 'text-green-600' :
                                kpi.overall_score >= 70 ? 'text-yellow-600' :
                                'text-red-600'
                              }`}>
                                {kpi.overall_score?.toFixed(0)}
                              </span>
                            </div>
                          ) : (
                            <span className="text-slate-400 text-xs">-</span>
                          )}
                        </td>

                        <td className="px-4 py-3 border-b text-center">
                          {hasKpiData ? getRiskBadge(kpi.risk_level) : getRiskBadge('unknown')}
                        </td>

                        <td className="px-4 py-3 border-b">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              onClick={() => openEditModal(supplier)}
                              className="p-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition"
                              title="Edit"
                            >
                              <Edit2 className="w-4 h-4 text-blue-600" />
                            </button>
                            <button
                              onClick={() => openDeleteModal(supplier)}
                              className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition"
                              title="Delete"
                            >
                              <Trash2 className="w-4 h-4 text-red-600" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex justify-between items-center mt-4 pt-4 border-t">
                  <div className="text-sm text-slate-500">
                    Showing {(currentPage - 1) * rowsPerPage + 1} to{' '}
                    {Math.min(currentPage * rowsPerPage, filteredSuppliers.length)} of{' '}
                    {filteredSuppliers.length} entries
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="px-3 py-1 text-sm"
                    >
                      Previous
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
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-12">
              <Database className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                No Supplier Data
              </h3>
              <p className="text-slate-500 mb-4">
                Click "Add Supplier" button to add your first supplier
              </p>
              <Button
                variant="primary"
                icon={Plus}
                onClick={() => setShowAddModal(true)}
              >
                Add Supplier
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
              <h3 className="text-lg font-semibold">Add Supplier</h3>
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
                  Supplier Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.supplier_name}
                  onChange={(e) =>
                    setFormData({ ...formData, supplier_name: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Enter supplier name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Contact Info</label>
                <input
                  type="text"
                  value={formData.contact_info}
                  onChange={(e) =>
                    setFormData({ ...formData, contact_info: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Phone or Email"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium mb-1">Address</label>
                <input
                  type="text"
                  value={formData.address}
                  onChange={(e) =>
                    setFormData({ ...formData, address: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="Enter address"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Product Category</label>
                <input
                  type="text"
                  value={formData.product_category}
                  onChange={(e) =>
                    setFormData({ ...formData, product_category: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g., Electronic Components"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Payment Terms</label>
                <input
                  type="text"
                  value={formData.payment_terms}
                  onChange={(e) =>
                    setFormData({ ...formData, payment_terms: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g., Net 30"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Delivery Time</label>
                <input
                  type="text"
                  value={formData.delivery_time}
                  onChange={(e) =>
                    setFormData({ ...formData, delivery_time: e.target.value })
                  }
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-transparent focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g., 7-14 days"
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
                Cancel
              </Button>
              <Button variant="primary" onClick={handleAdd} disabled={loading}>
                {loading ? 'Adding...' : 'Add Supplier'}
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
              <h3 className="text-lg font-semibold">Edit Supplier</h3>
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
                  Supplier Name <span className="text-red-500">*</span>
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
                <label className="block text-sm font-medium mb-1">Contact Info</label>
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
                <label className="block text-sm font-medium mb-1">Address</label>
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
                <label className="block text-sm font-medium mb-1">Product Category</label>
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
                <label className="block text-sm font-medium mb-1">Payment Terms</label>
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
                <label className="block text-sm font-medium mb-1">Delivery Time</label>
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
                Cancel
              </Button>
              <Button variant="primary" onClick={handleEdit} disabled={loading}>
                {loading ? 'Updating...' : 'Update Supplier'}
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
                  <h3 className="text-lg font-semibold">Bulk Import Suppliers</h3>
                  <p className="text-sm text-slate-500">
                    Preview {importPreview.length} suppliers to import
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
                    <th className="px-4 py-2 text-left">Supplier Name</th>
                    <th className="px-4 py-2 text-left">Contact Info</th>
                    <th className="px-4 py-2 text-left">Address</th>
                    <th className="px-4 py-2 text-left">Product Category</th>
                  </tr>
                </thead>
                <tbody>
                  {importPreview.map((supplier, idx) => (
                    <tr key={idx} className="border-b border-slate-200 dark:border-slate-700">
                      <td className="px-4 py-2">{idx + 1}</td>
                      <td className="px-4 py-2 font-medium">{supplier.supplier_name}</td>
                      <td className="px-4 py-2">{formatContactInfo(supplier.contact_info)}</td>
                      <td className="px-4 py-2">{supplier.contact_info?.address || '-'}</td>
                      <td className="px-4 py-2">{supplier.contact_info?.product_category || '-'}</td>
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
                  Import progress: {importProgress}%
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
                Cancel
              </Button>
              <Button
                variant="success"
                icon={Upload}
                onClick={handleImportConfirm}
                disabled={importProgress > 0 && importProgress < 100}
              >
                Import {importPreview.length} Suppliers
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
        title="Delete Supplier?"
        description="This action cannot be undone"
        icon={Trash2}
        iconBgColor="bg-red-100 dark:bg-red-900/30"
        iconColor="text-red-600"
        confirmText="Delete"
        confirmVariant="danger"
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Are you sure you want to delete supplier "{selectedSupplier?.supplier_name}"?
        </p>
      </Modal>
    </div>
  );
};

export default SupplierManagementView;
