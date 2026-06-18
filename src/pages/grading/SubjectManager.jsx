import { useState, useEffect } from 'react';
import { gradingService } from '../../services/gradingService';
import { BookOpen, Plus, Trash2, Loader2, Layers } from 'lucide-react';
import { Modal, Field, ErrorBox } from './SemesterManager';

export default function SubjectManager() {
  const [subjects, setSubjects] = useState([]);
  const [fetching, setFetching] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', title: '', units: 3 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [listError, setListError] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setFetching(true);
    try {
      const { data } = await gradingService.getSubjects();
      setSubjects(data);
    } finally {
      setFetching(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await gradingService.createSubject(form);
      setForm({ code: '', title: '', units: 3 });
      setOpen(false);
      await load();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create subject');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    if (!confirm('Delete this subject?')) return;
    setListError(null);
    try {
      await gradingService.deleteSubject(id);
      await load();
    } catch (err) {
      setListError(err?.response?.data?.error || 'Failed to delete subject');
    }
  }

  const inputClass = `w-full bg-gray-50 border border-gray-200
    rounded-xl px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400
    focus:ring-2 focus:ring-blue-500 focus:border-transparent focus:outline-none transition-all`;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="inline-flex items-center gap-2 bg-gray-100 px-3 py-1.5 rounded-xl text-sm text-gray-600">
          <BookOpen size={15} />
          {subjects.length} subject{subjects.length !== 1 ? 's' : ''}
        </div>
        <button onClick={() => setOpen(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
          <Plus size={16} /> Add Subject
        </button>
      </div>

      {listError && <div className="mb-4"><ErrorBox>{listError}</ErrorBox></div>}

      {fetching ? (
        <div className="flex flex-col gap-4">{[1, 2, 3].map((i) => <div key={i} className="animate-pulse bg-gray-100 rounded-2xl h-20" />)}</div>
      ) : subjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <BookOpen size={40} className="text-gray-300 mb-4" />
          <p className="text-base font-medium text-gray-500">No subjects yet</p>
          <p className="text-sm text-gray-400 mt-1">Add your first subject to start managing grades.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {subjects.map((s) => (
            <div key={s.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-2xl p-5">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-gray-900">{s.title}</span>
                  <span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-lg">{s.code}</span>
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-500">
                  <Layers size={13} /><span>{s.units} unit{s.units !== 1 ? 's' : ''}</span>
                  <span>·</span>
                  <span>{s._count?.sections || 0} section{(s._count?.sections || 0) !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <button onClick={() => remove(s.id)} className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-600 hover:bg-red-50 px-3 py-1.5 rounded-xl transition-colors border border-transparent hover:border-red-200">
                <Trash2 size={15} /> Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <Modal onClose={() => { setOpen(false); setError(null); }} title="New Subject">
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            {error && <ErrorBox>{error}</ErrorBox>}
            <Field label="Subject code"><input required placeholder="e.g. CS101" className={inputClass} value={form.code} onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))} /></Field>
            <Field label="Subject title"><input required placeholder="e.g. Introduction to Programming" className={inputClass} value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} /></Field>
            <Field label="Units"><input required type="number" min="0" step="0.5" className={inputClass} value={form.units} onChange={(e) => setForm((p) => ({ ...p, units: e.target.value }))} /></Field>
            <div className="flex gap-3 justify-end mt-2">
              <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
              <button type="submit" disabled={saving} className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors">
                {saving && <Loader2 size={14} className="animate-spin" />} Create subject
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
