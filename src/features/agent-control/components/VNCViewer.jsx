import { useEffect, useRef, useState } from 'react';
import { X, Maximize, Minimize, Power, Lock } from 'lucide-react';
import { agentsApi } from '../../../services/api.js';

const VNCViewer = ({ computer, onClose }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [vncInfo, setVncInfo] = useState(null);
  const [error, setError] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isControlling, setIsControlling] = useState(false);
  const iframeRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    startVNCSession();
    return () => {
      // Stop VNC when component unmounts
      stopVNCSession();
    };
  }, [computer.id]);

  const startVNCSession = async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Send command to start VNC on the agent
      const response = await agentsApi.sendCommand(computer.id, 'vnc-start', {
        password: generateRandomPassword(8),
        port: 5900
      });

      if (response.data?.success) {
        setVncInfo(response.data.result);
        setIsLoading(false);
        
        // Connect to VNC after a short delay to let server start
        setTimeout(() => {
          connectToVNC(response.data.result);
        }, 2000);
      } else {
        setError(response.data?.error || 'Failed to start VNC');
        setIsLoading(false);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to start VNC session');
      setIsLoading(false);
    }
  };

  const stopVNCSession = async () => {
    try {
      await agentsApi.sendCommand(computer.id, 'vnc-stop');
    } catch (err) {
      console.error('Error stopping VNC:', err);
    }
  };

  const connectToVNC = (vncData) => {
    // For this implementation, we'll use a noVNC client or direct VNC connection
    // In a production environment, you'd embed noVNC or use a WebSocket VNC proxy
    
    // Option 1: Use external VNC client link (for now)
    const vncUrl = `vnc://${computer.ip}:${vncData.port || 5900}`;
    
    // Option 2: Embed noVNC (would require noVNC to be served)
    // const noVNCUrl = `/novnc/vnc.html?host=${computer.ip}&port=${vncData.port || 5900}&password=${vncData.password}`;

    // For demo, show connection info
    setVncInfo(prev => ({
      ...prev,
      connectionUrl: vncUrl,
      noVNCUrl: `/novnc/vnc.html?host=${computer.ip}&port=${vncData.port || 5900}`
    }));
  };

  const generateRandomPassword = (length) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < length; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const handleLockPC = async () => {
    try {
      await agentsApi.sendCommand(computer.id, 'lock');
      alert('Lock command sent to PC');
    } catch (err) {
      alert('Failed to lock PC: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleShutdownPC = async () => {
    if (!confirm('Are you sure you want to shutdown this PC?')) return;
    try {
      await agentsApi.sendCommand(computer.id, 'shutdown', { delay: 0 });
      alert('Shutdown command sent to PC');
    } catch (err) {
      alert('Failed to shutdown PC: ' + (err.response?.data?.error || err.message));
    }
  };

  const openExternalVNC = () => {
    if (vncInfo?.connectionUrl) {
      // Try to open VNC URL - this will launch the default VNC client
      window.open(vncInfo.connectionUrl, '_blank');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div 
        ref={containerRef}
        className={`bg-gray-900 rounded-lg overflow-hidden flex flex-col ${
          isFullscreen ? 'w-screen h-screen' : 'w-full max-w-6xl h-[80vh] mx-4'
        }`}
      >
        {/* Header */}
        <div className="bg-gray-800 text-white px-4 py-3 flex items-center justify-between border-b border-gray-700">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-lg">
              {computer.name || computer.hostname}
            </h3>
            <span className="text-sm text-gray-400">
              {computer.ip}
            </span>
            {vncInfo?.password && (
              <span className="text-xs bg-yellow-600 text-white px-2 py-1 rounded">
                VNC Password: {vncInfo.password}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {/* Control Buttons */}
            <button
              onClick={handleLockPC}
              className="p-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-2 transition-colors"
              title="Lock PC"
            >
              <Lock className="w-4 h-4" />
              <span className="text-sm">Lock</span>
            </button>
            
            <button
              onClick={handleShutdownPC}
              className="p-2 bg-red-600 hover:bg-red-700 text-white rounded-lg flex items-center gap-2 transition-colors"
              title="Shutdown PC"
            >
              <Power className="w-4 h-4" />
              <span className="text-sm">Shutdown</span>
            </button>

            <div className="w-px h-6 bg-gray-600 mx-2" />

            {/* View Controls */}
            <button
              onClick={toggleFullscreen}
              className="p-2 text-gray-300 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
            
            <button
              onClick={onClose}
              className="p-2 text-gray-300 hover:text-white hover:bg-red-600 rounded-lg transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 bg-black relative overflow-hidden">
          {isLoading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mb-4" />
              <p className="text-white">Starting VNC session...</p>
              <p className="text-gray-400 text-sm mt-2">Connecting to {computer.ip}:5900</p>
            </div>
          ) : error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="bg-red-900 text-red-100 px-6 py-4 rounded-lg max-w-md">
                <h4 className="font-semibold mb-2">Failed to Start VNC</h4>
                <p className="text-sm">{error}</p>
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={startVNCSession}
                    className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded text-sm transition-colors"
                  >
                    Retry
                  </button>
                  <button
                    onClick={onClose}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : vncInfo ? (
            <div className="absolute inset-0 flex flex-col">
              {/* VNC Viewer Placeholder - In production, embed noVNC here */}
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div className="bg-gray-800 p-8 rounded-lg max-w-md">
                    <h4 className="text-white font-semibold mb-4">VNC Session Ready</h4>
                    
                    <div className="text-left text-sm space-y-2 mb-6">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Host:</span>
                        <span className="text-white font-mono">{computer.ip}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Port:</span>
                        <span className="text-white font-mono">{vncInfo.port || 5900}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Password:</span>
                        <span className="text-yellow-400 font-mono font-semibold">{vncInfo.password}</span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <button
                        onClick={openExternalVNC}
                        className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                      >
                        Open in VNC Viewer
                      </button>
                      
                      <p className="text-gray-500 text-xs mt-4">
                        Click above to launch your default VNC client. 
                        If no client is installed, download TightVNC or RealVNC.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Connection Info Footer */}
              <div className="bg-gray-800 px-4 py-2 text-xs text-gray-400 flex items-center justify-between">
                <span>Connection: {vncInfo.connectionUrl}</span>
                <span>Session active • Click "Open in VNC Viewer" to view screen</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export { VNCViewer };
export default VNCViewer;
