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
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Audit log</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">Every grade-affecting action: who, what, when. Most recent 200 entries.</p>
          </div>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 px-3 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700"><RefreshCw size={14} /> Refresh</button>
      </div>

      {loading ? (
        <div className="animate-pulse bg-zinc-100 dark:bg-zinc-800 rounded-2xl h-64" />
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ScrollText size={40} className="text-zinc-300 dark:text-zinc-600 mb-4" />
          <p className="text-base font-medium text-zinc-500">No activity yet</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-800">
                  {['When', 'Actor', 'Action', 'Detail', 'Reason'].map((h) => <th key={h} className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400 whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <td className="px-5 py-3 text-xs text-zinc-400 whitespace-nowrap">{fmtTime(l.createdAt)}</td>
                    <td className="px-5 py-3 text-zinc-600 dark:text-zinc-300 whitespace-nowrap">{l.actor?.fullName || 'System'}<span className="text-xs text-zinc-400 ml-1">{l.actor?.role ? `(${l.actor.role.toLowerCase()})` : ''}</span></td>
                    <td className="px-5 py-3"><span className="font-mono text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 px-2 py-0.5 rounded-lg whitespace-nowrap">{l.action}</span></td>
                    <td className="px-5 py-3 text-zinc-500">{l.detail || (l.oldValue != null || l.newValue != null ? `${l.oldValue ?? '—'} → ${l.newValue ?? '—'}` : '—')}</td>
                    <td className="px-5 py-3 text-zinc-500">{l.reason || '—'}</td>
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
