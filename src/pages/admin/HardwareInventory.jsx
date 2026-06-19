import { useState, useEffect } from "react";
import { labsApi, hardwareInventoryApi } from "../../services/api.js";
import {
  Search,
  Plus,
  Edit2,
  Trash2,
  Monitor,
  Cpu,
  Keyboard,
  Mouse,
  Headphones,
  Camera,
  Zap,
  Printer,
  Package,
  Filter,
  CheckCircle,
  AlertCircle,
  XCircle,
  Loader2,
  X,
  Save,
} from "lucide-react";

// Constants
const DEVICE_TYPES = [
  { value: "MONITOR", label: "Monitor", icon: Monitor },
  { value: "CPU", label: "CPU", icon: Cpu },
  { value: "KEYBOARD", label: "Keyboard", icon: Keyboard },
  { value: "MOUSE", label: "Mouse", icon: Mouse },
  { value: "HEADSET", label: "Headset", icon: Headphones },
  { value: "WEBCAM", label: "Webcam", icon: Camera },
  { value: "UPS", label: "UPS", icon: Zap },
  { value: "PRINTER", label: "Printer", icon: Printer },
  { value: "OTHER", label: "Other", icon: Package },
];

const CONDITION_OPTIONS = [
  { value: "GOOD", label: "Good", variant: "success" },
  { value: "FAIR", label: "Fair", variant: "warning" },
  { value: "POOR", label: "Poor", variant: "destructive" },
  { value: "DAMAGED", label: "Damaged", variant: "destructive" },
];

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active", variant: "success" },
  { value: "INACTIVE", label: "Inactive", variant: "default" },
  { value: "UNDER_REPAIR", label: "Under Repair", variant: "warning" },
  { value: "MISSING", label: "Missing", variant: "destructive" },
];

// Badge component (consistent with existing design)
const Badge = ({ variant, children }) => {
  const variants = {
    default: "bg-gray-100 text-gray-800",
    success: "bg-green-100 text-green-800",
    warning: "bg-yellow-100 text-yellow-800",
    destructive: "bg-red-100 text-red-800",
    info: "bg-blue-100 text-blue-800",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${variants[variant] || variants.default}`}
    >
      {children}
    </span>
  );
};

// Toast notification component
const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div
      className={`fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 z-50 ${
        type === "success" ? "bg-green-600 text-white" : "bg-red-600 text-white"
      }`}
    >
      {type === "success" ? (
        <CheckCircle className="w-5 h-5" />
      ) : (
        <AlertCircle className="w-5 h-5" />
      )}
      <span className="text-sm font-medium">{message}</span>
    </div>
  );
};

function HardwareInventory() {
  // State management
  const [labs, setLabs] = useState([]);
  const [selectedLab, setSelectedLab] = useState(null);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Filter states
  const [searchTerm, setSearchTerm] = useState("");
  const [deviceTypeFilter, setDeviceTypeFilter] = useState("all");
  const [conditionFilter, setConditionFilter] = useState("all");

  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState("add"); // 'add' or 'edit'
  const [selectedItem, setSelectedItem] = useState(null);
  const [modalError, setModalError] = useState(null);
  const [submitLoading, setSubmitLoading] = useState(false);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Toast notification
  const [toast, setToast] = useState(null);

  // Form state
  const [formData, setFormData] = useState({
    name: "",
    deviceType: "",
    model: "",
    serialNumber: "",
    condition: "GOOD",
    status: "ACTIVE",
    notes: "",
    laboratoryId: "",
  });

  // Fetch labs on mount
  useEffect(() => {
    fetchLabs();
  }, []);

  // Fetch inventory data when lab is selected or filters change
  useEffect(() => {
    if (selectedLab) {
      fetchInventoryData();
    }
  }, [selectedLab, searchTerm, deviceTypeFilter, conditionFilter]);

  const fetchLabs = async () => {
    try {
      const response = await labsApi.getAll();
      setLabs(response.data.data || []);

      // Auto-select first lab if available
      if (response.data.data && response.data.data.length > 0) {
        setSelectedLab(response.data.data[0]);
      }
    } catch (err) {
      console.error("Error fetching labs:", err);
      setError("Failed to load laboratories");
    }
  };

  const fetchInventoryData = async () => {
    if (!selectedLab) return;

    try {
      setLoading(true);
      setError(null);

      const [itemsRes, statsRes] = await Promise.all([
        hardwareInventoryApi.getByLaboratory(selectedLab.id, {
          search: searchTerm,
          deviceType: deviceTypeFilter !== "all" ? deviceTypeFilter : undefined,
          condition: conditionFilter !== "all" ? conditionFilter : undefined,
        }),
        hardwareInventoryApi.getStats(selectedLab.id),
      ]);

      setInventoryItems(itemsRes.data.data || []);
      // API wraps the payload as { success, data }; unwrap the inner object so
      // the summary cards read stats.total / good / needAttention / underRepairOrMissing.
      setStats(statsRes.data.data || null);
    } catch (err) {
      console.error("Error fetching inventory data:", err);
      setError("Failed to load inventory data");
    } finally {
      setLoading(false);
    }
  };

  const showToast = (message, type = "success") => {
    setToast({ message, type });
  };

  const handleOpenAddModal = () => {
    setModalMode("add");
    setSelectedItem(null);
    setFormData({
      name: "",
      deviceType: "",
      model: "",
      serialNumber: "",
      condition: "GOOD",
      status: "ACTIVE",
      notes: "",
      laboratoryId: selectedLab?.id || "",
    });
    setModalError(null);
    setShowModal(true);
  };

  const handleOpenEditModal = (item) => {
    setModalMode("edit");
    setSelectedItem(item);
    setFormData({
      name: item.name,
      deviceType: item.deviceType,
      model: item.model || "",
      serialNumber: item.serialNumber,
      condition: item.condition,
      status: item.status,
      notes: item.notes || "",
      laboratoryId: item.laboratoryId,
    });
    setModalError(null);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setSelectedItem(null);
    setModalError(null);
    setSubmitLoading(false);
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async () => {
    // Validation
    if (!formData.name.trim()) {
      setModalError("Device name is required");
      return;
    }

    if (!formData.deviceType) {
      setModalError("Device type is required");
      return;
    }

    if (!formData.serialNumber.trim()) {
      setModalError("Serial number is required");
      return;
    }

    if (!formData.laboratoryId) {
      setModalError("Laboratory is required");
      return;
    }

    try {
      setSubmitLoading(true);
      setModalError(null);

      if (modalMode === "add") {
        await hardwareInventoryApi.create(formData);
        showToast("Hardware item added successfully");
      } else {
        await hardwareInventoryApi.update(selectedItem.id, formData);
        showToast("Hardware item updated successfully");
      }

      handleCloseModal();
      fetchInventoryData();
    } catch (err) {
      console.error("Error saving hardware item:", err);
      setModalError(
        err.response?.data?.message || "Failed to save hardware item",
      );
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleDeleteClick = (item) => {
    setDeleteConfirm(item);
    setDeleteLoading(false);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;

    try {
      setDeleteLoading(true);
      await hardwareInventoryApi.delete(deleteConfirm.id);
      showToast("Hardware item deleted successfully");
      setDeleteConfirm(null);
      fetchInventoryData();
    } catch (err) {
      console.error("Error deleting hardware item:", err);
      const errorMessage =
        err.response?.data?.message || "Failed to delete hardware item";
      showToast(errorMessage, "error");
      setDeleteConfirm(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const getDeviceIcon = (deviceType) => {
    const device = DEVICE_TYPES.find((d) => d.value === deviceType);
    const Icon = device ? device.icon : Package;
    return <Icon className="w-5 h-5 text-gray-500" />;
  };

  const getConditionBadge = (condition) => {
    const conditionOption = CONDITION_OPTIONS.find(
      (c) => c.value === condition,
    );
    return (
      <Badge variant={conditionOption?.variant || "default"}>
        {conditionOption?.label || condition}
      </Badge>
    );
  };

  const getStatusBadge = (status) => {
    const statusOption = STATUS_OPTIONS.find((s) => s.value === status);
    return (
      <Badge variant={statusOption?.variant || "default"}>
        {statusOption?.label || status}
      </Badge>
    );
  };

  if (error && !selectedLab) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <p className="text-red-600">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Toast Notification */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Hardware Inventory
          </h1>
          <p className="text-gray-500">
            Manage and track laboratory equipment and devices
          </p>
        </div>
        <button
          className="flex items-center h-10 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors disabled:opacity-50"
          onClick={handleOpenAddModal}
          disabled={!selectedLab || loading}
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Item
        </button>
      </div>

      {/* Lab Selector */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-4">
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium text-gray-700">
              Select Laboratory:
            </label>
            <select
              value={selectedLab?.id || ""}
              onChange={(e) => {
                const lab = labs.find((l) => l.id === parseInt(e.target.value));
                setSelectedLab(lab);
              }}
              className="flex-1 max-w-md h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">-- Select Laboratory --</option>
              {labs.map((lab) => (
                <option key={lab.id} value={lab.id}>
                  {lab.name} ({lab.building} - {lab.roomNumber})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {selectedLab && (
        <>
          {/* Stats Cards */}
          {stats && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center mr-3">
                    <Package className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Total Items</p>
                    <p className="text-xl font-bold text-gray-900">
                      {stats.total}
                    </p>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center mr-3">
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Good Condition</p>
                    <p className="text-xl font-bold text-gray-900">
                      {stats.good}
                    </p>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-yellow-50 rounded-lg flex items-center justify-center mr-3">
                    <AlertCircle className="w-5 h-5 text-yellow-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Need Attention</p>
                    <p className="text-xl font-bold text-gray-900">
                      {stats.needAttention}
                    </p>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center mr-3">
                    <XCircle className="w-5 h-5 text-red-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">
                      Under Repair/Missing
                    </p>
                    <p className="text-xl font-bold text-gray-900">
                      {stats.underRepairOrMissing}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex-1 min-w-[200px] max-w-md relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search by name or serial number..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full h-10 pl-10 pr-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-gray-500" />
                  <select
                    value={deviceTypeFilter}
                    onChange={(e) => setDeviceTypeFilter(e.target.value)}
                    className="h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="all">All Device Types</option>
                    {DEVICE_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </div>
                <select
                  value={conditionFilter}
                  onChange={(e) => setConditionFilter(e.target.value)}
                  className="h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All Conditions</option>
                  {CONDITION_OPTIONS.map((condition) => (
                    <option key={condition.value} value={condition.value}>
                      {condition.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Inventory Table */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">
                Hardware Items - {selectedLab.name}
              </h3>
            </div>
            <div className="p-0">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                  <span className="ml-2 text-gray-600">
                    Loading inventory...
                  </span>
                </div>
              ) : inventoryItems.length === 0 ? (
                <div className="text-center py-12">
                  <Package className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-500">
                    {searchTerm ||
                    deviceTypeFilter !== "all" ||
                    conditionFilter !== "all"
                      ? "No items found matching your filters."
                      : "No hardware items found in this laboratory."}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Device
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Type
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Model
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Serial Number
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Condition
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {inventoryItems.map((item) => (
                        <tr
                          key={item.id}
                          className="hover:bg-gray-50 transition-colors"
                        >
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="flex items-center">
                              <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center mr-3">
                                {getDeviceIcon(item.deviceType)}
                              </div>
                              <span className="text-sm font-medium text-gray-900">
                                {item.name}
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {DEVICE_TYPES.find(
                              (d) => d.value === item.deviceType,
                            )?.label || item.deviceType}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {item.model || "-"}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-600">
                            {item.serialNumber}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            {getConditionBadge(item.condition)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            {getStatusBadge(item.status)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="flex items-center space-x-2">
                              <button
                                className="p-1 hover:bg-gray-100 rounded transition-colors"
                                title="Edit"
                                onClick={() => handleOpenEditModal(item)}
                              >
                                <Edit2 className="w-4 h-4 text-gray-600" />
                              </button>
                              <button
                                className="p-1 hover:bg-gray-100 rounded transition-colors"
                                title="Delete"
                                onClick={() => handleDeleteClick(item)}
                              >
                                <Trash2 className="w-4 h-4 text-red-500" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-gray-900">
                  {modalMode === "add"
                    ? "Add Hardware Item"
                    : "Edit Hardware Item"}
                </h2>
                <button
                  onClick={handleCloseModal}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-4">
              {/* Modal Error */}
              {modalError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
                  <span className="text-sm text-red-700">{modalError}</span>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Device Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="name"
                  placeholder="e.g., Dell Monitor 24"
                  value={formData.name}
                  onChange={handleInputChange}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Device Type <span className="text-red-500">*</span>
                </label>
                <select
                  name="deviceType"
                  value={formData.deviceType}
                  onChange={handleInputChange}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">-- Select Device Type --</option>
                  {DEVICE_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Model
                </label>
                <input
                  type="text"
                  name="model"
                  placeholder="e.g., P2419H"
                  value={formData.model}
                  onChange={handleInputChange}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Serial Number <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="serialNumber"
                  placeholder="e.g., SN123456789"
                  value={formData.serialNumber}
                  onChange={handleInputChange}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Condition
                  </label>
                  <select
                    name="condition"
                    value={formData.condition}
                    onChange={handleInputChange}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {CONDITION_OPTIONS.map((condition) => (
                      <option key={condition.value} value={condition.value}>
                        {condition.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Status
                  </label>
                  <select
                    name="status"
                    value={formData.status}
                    onChange={handleInputChange}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {STATUS_OPTIONS.map((status) => (
                      <option key={status.value} value={status.value}>
                        {status.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Notes
                </label>
                <textarea
                  name="notes"
                  rows={3}
                  placeholder="Additional notes about this hardware item..."
                  value={formData.notes}
                  onChange={handleInputChange}
                  className="w-full px-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <div className="p-6 border-t border-gray-200 flex justify-end space-x-3">
              <button
                className="h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                onClick={handleCloseModal}
                disabled={submitLoading}
              >
                Cancel
              </button>
              <button
                className="flex items-center h-10 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors disabled:opacity-50"
                onClick={handleSubmit}
                disabled={submitLoading}
              >
                {submitLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4 mr-2" />
                    {modalMode === "add" ? "Add Item" : "Update Item"}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-100 rounded-full">
                <AlertCircle className="w-6 h-6 text-red-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900">
                Delete Hardware Item
              </h3>
            </div>
            <p className="text-gray-600 mb-4">
              Are you sure you want to delete{" "}
              <strong>{deleteConfirm.name}</strong> (
              {deleteConfirm.serialNumber})?
            </p>
            <div className="flex justify-end space-x-3">
              <button
                className="h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteLoading}
              >
                Cancel
              </button>
              <button
                className="flex items-center h-10 px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors disabled:opacity-50"
                onClick={handleDeleteConfirm}
                disabled={deleteLoading}
              >
                {deleteLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete Item
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default HardwareInventory;
