import { X, Monitor, Settings } from 'lucide-react';

const DeveloperMode = ({ onClose }) => {
  return (
    <div className="modal-overlay">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="bg-gray-900 text-white p-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Monitor className="w-6 h-6" />
            <div>
              <h2 className="text-xl font-bold">Developer Mode</h2>
              <p className="text-gray-300 text-sm">System information panel</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="p-3 bg-gray-100 rounded-lg">
              <Settings className="w-6 h-6 text-gray-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">Developer Features</h3>
              <p className="text-sm text-gray-500">PC management tools are currently disabled.</p>
            </div>
          </div>
          
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p className="text-sm text-yellow-800">
              <strong>Note:</strong> The Connected PCs, Lock PC, and View PC features have been removed from this version.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="bg-gray-50 px-6 py-4 border-t border-gray-200 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeveloperMode;
