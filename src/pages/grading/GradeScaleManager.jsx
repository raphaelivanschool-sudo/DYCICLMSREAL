import { useState, useEffect } from 'react';
import { gradingService } from '../../services/gradingService';
import { SlidersHorizontal, Plus, Trash2, Loader2, Save, RotateCcw, CheckCircle2 } from 'lucide-react';
import { ErrorBox } from './SemesterManager';

const DEFAULT_ROWS = [
  { minPercent: 97, maxPercent: 100, gradePoint: 1.0, label: 'Excellent' },
  { minPercent: 94, maxPercent: 96, gradePoint: 1.25, label: 'Excellent' },
  { minPercent: 91, maxPercent: 93, gradePoint: 1.5, label: 'Very Good' },
  { minPercent: 88, maxPercent: 90, gradePoint: 1.75, label: 'Very Good' },
  { minPercent: 85, maxPercent: 87, gradePoint: 2.0, label: 'Good' },
  { minPercent: 82, maxPercent: 84, gradePoint: 2.25, label: 'Good' },
  { minPercent: 79, maxPercent: 81, gradePoint: 2.5, label: 'Satisfactory' },
  { minPercent: 76, maxPercent: 78, gradePoint: 2.75, label: 'Satisfactory' },
  { minPercent: 75, maxPercent: 75, gradePoint: 3.0, label: 'Passing' },
  { minPercent: 0, maxPercent: 74.99, gradePoint: 5.0, label: 'Failed' },
];

export default function GradeScaleManager() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { data } = await gradingService.getScale();
      setRows(data.map((r) => ({ minPercent: r.minPercent, maxPercent: r.maxPercent, gradePoint: r.gradePoint, label: r.label || '' })));
    } finally {
      setLoading(false);
    }
  }

  function update(i, field, value) {
    setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
    setSaved(false);
  }
  function addRow() { setRows((prev) => [...prev, { minPercent: 0, maxPercent: 0, gradePoint: 5.0, label: '' }]); }
  function removeRow(i) { setRows((prev) => prev.filter((_, idx) => idx !== i)); }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = rows.map((r) => ({
        minPercent: parseFloat(r.minPercent),
        maxPercent: parseFloat(r.maxPercent),
        gradePoint: parseFloat(r.gradePoint),
        label: r.label || null,
      }));
      if (payload.some((r) => r.gradePoint === 4.0)) {
        setError('There is no 4.00 in this grading model. Remove any 4.00 rows.');
        setSaving(false);
        return;
      }
      const { data } = await gradingService.updateScale(payload);
      setRows(data.map((r) => ({ minPercent: r.minPercent, maxPercent: r.maxPercent, gradePoint: r.gradePoint, label: r.label || '' })));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to save scale');
    } finally {
      setSaving(false);
    }
  }

  const cell = 'w-full bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-sm font-mono text-center focus:ring-2 focus:ring-blue-500 focus:outline-none';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <SlidersHorizontal size={18} className="text-blue-600 mt-0.5" />
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Transmutation scale</h3>
          <p className="text-sm text-gray-500 mt-0.5">Maps a weighted percentage to the 1.00–5.00 grade point. 3.00 is the lowest passing (75%); below 75% is 5.00; there is no 4.00.</p>
        </div>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {loading ? (
        <div className="animate-pulse bg-gray-100 rounded-2xl h-64" />
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {['Min %', 'Max %', 'Grade point', 'Label', ''].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-2 w-28"><input type="number" step="0.01" className={cell} value={r.minPercent} onChange={(e) => update(i, 'minPercent', e.target.value)} /></td>
                  <td className="px-4 py-2 w-28"><input type="number" step="0.01" className={cell} value={r.maxPercent} onChange={(e) => update(i, 'maxPercent', e.target.value)} /></td>
                  <td className="px-4 py-2 w-28"><input type="number" step="0.25" className={cell} value={r.gradePoint} onChange={(e) => update(i, 'gradePoint', e.target.value)} /></td>
                  <td className="px-4 py-2"><input className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none" value={r.label} onChange={(e) => update(i, 'label', e.target.value)} /></td>
                  <td className="px-4 py-2 text-right"><button onClick={() => removeRow(i)} className="text-gray-400 hover:text-red-500"><Trash2 size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-3 border-t border-gray-200">
            <button onClick={addRow} className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"><Plus size={15} /> Add row</button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-xl text-sm font-medium disabled:opacity-50 transition-colors">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save scale
        </button>
        <button onClick={() => { setRows(DEFAULT_ROWS.map((r) => ({ ...r, label: r.label || '' }))); setSaved(false); }} className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 px-4 py-2 rounded-xl border border-gray-200">
          <RotateCcw size={15} /> Reset to default
        </button>
        {saved && <span className="inline-flex items-center gap-1.5 text-sm text-emerald-600"><CheckCircle2 size={15} /> Saved</span>}
      </div>
    </div>
  );
}
