import { useState } from 'react';
import { Download, Calendar, FileSpreadsheet } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const getAuthToken = () => {
  const token = localStorage.getItem('token');
  return token ? `Bearer ${token}` : null;
};

const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Pull a filename out of a Content-Disposition header (best effort). */
const filenameFromDisposition = (disposition, fallback) => {
  if (!disposition) return fallback;
  const utf8 = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition);
  const quoted = /filename="([^"]+)"/i.exec(disposition);
  const plain = /filename=([^;\s]+)/i.exec(disposition);
  if (utf8) return decodeURIComponent(utf8[1]);
  if (quoted) return quoted[1];
  if (plain) return plain[1].replace(/^["']|["']$/g, '');
  return fallback;
};

/**
 * Reusable date-range + CSV-download panel.
 *
 * @param {string} title
 * @param {string} description
 * @param {{ key:string, label:string, description?:string, endpoint:string,
 *           filters?: { key:string, label:string, placeholder?:string }[] }[]} reports
 *   `endpoint` is the path under /api/reports (e.g. "lab-utilization").
 */
export default function ReportDownloader({ title, description, reports }) {
  const [startDate, setStartDate] = useState(isoDaysAgo(30));
  const [endDate, setEndDate] = useState(isoDaysAgo(0));
  const [filterValues, setFilterValues] = useState({});
  const [downloadingKey, setDownloadingKey] = useState(null);
  const [error, setError] = useState(null);

  const setFilter = (k, v) => setFilterValues((prev) => ({ ...prev, [k]: v }));

  const handleDownload = async (report) => {
    const auth = getAuthToken();
    if (!auth) {
      setError('You must be signed in to download reports.');
      return;
    }
    setError(null);
    setDownloadingKey(report.key);
    try {
      const params = new URLSearchParams({ start: startDate, end: endDate });
      for (const f of report.filters || []) {
        const v = filterValues[`${report.key}:${f.key}`];
        if (v) params.set(f.key, v);
      }
      const url = `${API_URL}/api/reports/${report.endpoint}?${params.toString()}`;
      const response = await fetch(url, { headers: { Authorization: auth } });
      if (!response.ok) {
        let message = `Download failed (${response.status})`;
        try {
          const body = await response.json();
          if (body?.message) message = body.message;
        } catch {
          /* not JSON */
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const filename = filenameFromDisposition(
        response.headers.get('Content-Disposition'),
        `${report.endpoint}_${startDate}_${endDate}.csv`,
      );
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (err) {
      console.error('Report download:', err);
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloadingKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        {description && <p className="text-gray-500">{description}</p>}
      </div>

      {/* Shared date range */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-gray-500" />
            <span className="text-sm font-medium text-gray-700">Date range</span>
          </div>
          <label className="flex flex-col text-xs text-gray-500">
            From
            <input
              type="date"
              value={startDate}
              max={endDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <label className="flex flex-col text-xs text-gray-500">
            To
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1 h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Report list */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {reports.map((report) => (
          <div
            key={report.key}
            className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 flex flex-col"
          >
            <div className="flex items-start mb-2">
              <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center mr-3 shrink-0">
                <FileSpreadsheet className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-900">{report.label}</h3>
                {report.description && (
                  <p className="text-sm text-gray-500">{report.description}</p>
                )}
              </div>
            </div>

            {(report.filters || []).length > 0 && (
              <div className="flex flex-wrap gap-2 my-2">
                {report.filters.map((f) => (
                  <input
                    key={f.key}
                    type="text"
                    placeholder={f.placeholder || f.label}
                    value={filterValues[`${report.key}:${f.key}`] || ''}
                    onChange={(e) => setFilter(`${report.key}:${f.key}`, e.target.value)}
                    className="h-9 px-3 py-1.5 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                ))}
              </div>
            )}

            <div className="mt-auto pt-3">
              <button
                type="button"
                onClick={() => handleDownload(report)}
                disabled={downloadingKey === report.key}
                className="flex items-center h-10 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors disabled:opacity-50 disabled:pointer-events-none"
              >
                <Download className="w-4 h-4 mr-2 shrink-0" />
                {downloadingKey === report.key ? 'Preparing…' : 'Download CSV'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
