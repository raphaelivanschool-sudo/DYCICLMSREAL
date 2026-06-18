import { useState, useEffect } from 'react';
import { gradingService } from '../../services/gradingService';
import { ScrollText, RefreshCw } from 'lucide-react';

function fmtTime(t) {
  try { return new Date(t).toLocaleString(); } catch { return t; }
}

export default function AuditLogViewer() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { data } = await gradingService.getAudit();
      setLogs(data);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-start gap-3">
          <ScrollText size={18} className="text-blue-600 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-800">Audit log</h3>
            <p className="text-sm text-gray-500 mt-0.5">Every grade-affecting action: who, what, when. Most recent 200 entries.</p>
          </div>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-xl border border-gray-200"><RefreshCw size={14} /> Refresh</button>
      </div>

      {loading ? (
        <div className="animate-pulse bg-gray-100 rounded-2xl h-64" />
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ScrollText size={40} className="text-gray-300 mb-4" />
          <p className="text-base font-medium text-gray-500">No activity yet</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {['When', 'Actor', 'Action', 'Detail', 'Reason'].map((h) => <th key={h} className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-400 whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-5 py-3 text-xs text-gray-400 whitespace-nowrap">{fmtTime(l.createdAt)}</td>
                    <td className="px-5 py-3 text-gray-600 whitespace-nowrap">{l.actor?.fullName || 'System'}<span className="text-xs text-gray-400 ml-1">{l.actor?.role ? `(${l.actor.role.toLowerCase()})` : ''}</span></td>
                    <td className="px-5 py-3"><span className="font-mono text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-lg whitespace-nowrap">{l.action}</span></td>
                    <td className="px-5 py-3 text-gray-500">{l.detail || (l.oldValue != null || l.newValue != null ? `${l.oldValue ?? '—'} → ${l.newValue ?? '—'}` : '—')}</td>
                    <td className="px-5 py-3 text-gray-500">{l.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
