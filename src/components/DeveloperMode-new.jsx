import { X, Monitor } from 'lucide-react';

const DeveloperMode = ({ onClose }) => {
  return (
    <div className="modal-overlay">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="bg-gray-900 text-white p-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-3">
              <Monitor className="w-6 h-6" />
              Developer Mode
            </h2>
            <p className="text-gray-300 mt-1">System information panel</p>
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
          <p className="text-gray-600">Developer Mode is currently disabled.</p>
          <p className="text-gray-500 text-sm mt-2">This feature is not available in this version.</p>
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
