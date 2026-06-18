import { useState, useEffect } from 'react';
import { gradingService } from '../../services/gradingService';
import { CalendarRange, Plus, Loader2, AlertCircle, Lock, Unlock, CheckCircle2, X } from 'lucide-react';

export default function SemesterManager() {
  const [semesters, setSemesters] = useState([]);
  const [fetching, setFetching] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', isActive: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [unlockTarget, setUnlockTarget] = useState(null);
  const [unlockReason, setUnlockReason] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setFetching(true);
    try {
      const { data } = await gradingService.getSemesters();
      setSemesters(data);
    } finally {
      setFetching(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await gradingService.createSemester(form);
      setForm({ name: '', isActive: true });
      setOpen(false);
      await load();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create semester');
    } finally {
      setSaving(false);
    }
  }

  async function setActive(id) {
    await gradingService.updateSemester(id, { isActive: true });
    await load();
  }

  async function lock(id) {
    if (!confirm('Lock this semester? Grades become official and read-only to instructors.')) return;
    await gradingService.lockSemester(id);
    await load();
  }

  async function confirmUnlock() {
    if (!unlockReason.trim()) return;
    await gradingService.unlockSemester(unlockTarget, unlockReason.trim());
    setUnlockTarget(null);
    setUnlockReason('');
    await load();
  }

  const inputClass = `w-full bg-gray-50 border border-gray-200
    rounded-xl px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400
    focus:ring-2 focus:ring-blue-500 focus:border-transparent focus:outline-none transition-all`;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="inline-flex items-center gap-2 bg-gray-100 px-3 py-1.5 rounded-xl text-sm text-gray-600">
          <CalendarRange size={15} />
          {semesters.length} semester{semesters.length !== 1 ? 's' : ''}
        </div>
        <button onClick={() => setOpen(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
          <Plus size={16} /> New Semester
        </button>
      </div>

      {fetching ? (
        <div className="flex flex-col gap-4">{[1, 2].map((i) => <div key={i} className="animate-pulse bg-gray-100 rounded-2xl h-20" />)}</div>
      ) : semesters.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <CalendarRange size={40} className="text-gray-300 mb-4" />
          <p className="text-base font-medium text-gray-500">No semesters yet</p>
          <p className="text-sm text-gray-400 mt-1">Create a semester to start organizing sections and grades.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {semesters.map((s) => (
            <div key={s.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-2xl p-5">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-gray-900">{s.name}</span>
                  {s.isActive && <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-lg font-medium">Active</span>}
                  {s.status === 'LOCKED' && <span className="inline-flex items-center gap-1 text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-lg font-medium"><Lock size={11} /> Locked</span>}
                </div>
                <p className="text-xs text-gray-500 mt-1.5">{s._count?.sections || 0} section{(s._count?.sections || 0) !== 1 ? 's' : ''}</p>
              </div>
              <div className="flex items-center gap-2">
                {!s.isActive && (
                  <button onClick={() => setActive(s.id)} className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:bg-gray-50 px-3 py-1.5 rounded-xl border border-gray-200 transition-colors">
                    <CheckCircle2 size={15} /> Set active
                  </button>
                )}
                {s.status === 'LOCKED' ? (
                  <button onClick={() => setUnlockTarget(s.id)} className="inline-flex items-center gap-1.5 text-sm text-amber-600 hover:bg-amber-50 px-3 py-1.5 rounded-xl border border-amber-200 transition-colors">
                    <Unlock size={15} /> Unlock
                  </button>
                ) : (
                  <button onClick={() => lock(s.id)} className="inline-flex items-center gap-1.5 text-sm text-purple-600 hover:bg-purple-50 px-3 py-1.5 rounded-xl border border-purple-200 transition-colors">
                    <Lock size={15} /> Lock
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <Modal onClose={() => { setOpen(false); setError(null); }} title="New Semester">
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            {error && <ErrorBox>{error}</ErrorBox>}
            <Field label="Semester name">
              <input required placeholder="e.g. 1st Sem AY 2025-2026" className={inputClass} value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))} />
              Set as the active semester
            </label>
            <div className="flex gap-3 justify-end mt-2">
              <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
              <button type="submit" disabled={saving} className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors">
                {saving && <Loader2 size={14} className="animate-spin" />} Create
              </button>
            </div>
          </form>
        </Modal>
      )}

      {unlockTarget && (
        <Modal onClose={() => { setUnlockTarget(null); setUnlockReason(''); }} title="Unlock semester">
          <p className="text-sm text-gray-500 mb-4">Unlocking returns grades to instructors for editing. A reason is recorded in the audit log.</p>
          <textarea required rows={3} placeholder="Reason for unlocking..." className={inputClass} value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} />
          <div className="flex gap-3 justify-end mt-4">
            <button onClick={() => { setUnlockTarget(null); setUnlockReason(''); }} className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
            <button onClick={confirmUnlock} disabled={!unlockReason.trim()} className="px-4 py-2 rounded-xl text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition-colors">Unlock</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function Modal({ children, onClose, title }) {
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-xl w-full max-w-md relative">
        <button onClick={onClose} className="absolute top-5 right-5 text-gray-400 hover:text-gray-600 transition-colors"><X size={16} /></button>
        <h2 className="text-lg font-semibold text-gray-900 mb-5">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-gray-700">{label}</label>
      {children}
    </div>
  );
}

export function ErrorBox({ children }) {
  return (
    <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
      <AlertCircle size={15} className="mt-0.5 shrink-0" /><span>{children}</span>
    </div>
  );
}
