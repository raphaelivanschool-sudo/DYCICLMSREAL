import { useState, useEffect, useCallback } from 'react';
import { gradingService } from '../../services/gradingService';
import {
  Layers, Plus, Trash2, Loader2, ArrowLeft, Users, Search, UserPlus, X,
  CalendarRange, Lock, Unlock, ChevronRight,
} from 'lucide-react';
import { Modal, Field, ErrorBox } from './SemesterManager';
import GradebookView from './GradebookView';
import { STATUS_STYLE, STATUS_LABEL } from '../../utils/gradeUi';

export default function SectionsManager() {
  const [sections, setSections] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [instructors, setInstructors] = useState([]);
  const [filterSem, setFilterSem] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', subjectId: '', instructorId: '', semesterId: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const loadSections = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await gradingService.getSections(filterSem || undefined);
      setSections(data);
    } finally {
      setLoading(false);
    }
  }, [filterSem]);

  useEffect(() => {
    Promise.all([
      gradingService.getSemesters(),
      gradingService.getSubjects(),
      gradingService.getInstructors(),
    ]).then(([sem, subj, inst]) => {
      setSemesters(sem.data);
      setSubjects(subj.data);
      setInstructors(inst.data);
      const active = sem.data.find((s) => s.isActive);
      if (active) setForm((p) => ({ ...p, semesterId: String(active.id) }));
    });
  }, []);

  useEffect(() => { loadSections(); }, [loadSections]);

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await gradingService.createSection(form);
      setForm((p) => ({ ...p, name: '', subjectId: '', instructorId: '' }));
      setOpen(false);
      await loadSections();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create section');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    if (!confirm('Delete this section? Enrollments, categories and scores will be removed.')) return;
    await gradingService.deleteSection(id);
    await loadSections();
  }

  const selectClass = 'w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none';
  const inputClass = selectClass;

  if (selected) {
    return <SectionDetail section={selected} onBack={() => { setSelected(null); loadSections(); }} />;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-2 bg-gray-100 px-3 py-1.5 rounded-xl text-sm text-gray-600">
            <Layers size={15} /> {sections.length} section{sections.length !== 1 ? 's' : ''}
          </div>
          <select className={selectClass + ' !w-auto'} value={filterSem} onChange={(e) => setFilterSem(e.target.value)}>
            <option value="">All semesters</option>
            {semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <button onClick={() => setOpen(true)} disabled={subjects.length === 0 || instructors.length === 0 || semesters.length === 0} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-50" title={subjects.length === 0 ? 'Create a subject first' : ''}>
          <Plus size={16} /> New Section
        </button>
      </div>

      {loading ? (
        <div className="flex flex-col gap-4">{[1, 2, 3].map((i) => <div key={i} className="animate-pulse bg-gray-100 rounded-2xl h-20" />)}</div>
      ) : sections.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Layers size={40} className="text-gray-300 mb-4" />
          <p className="text-base font-medium text-gray-500">No sections yet</p>
          <p className="text-sm text-gray-400 mt-1">Create a section to assign a subject to an instructor for a semester.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {sections.map((s) => (
            <div key={s.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-2xl p-5">
              <button onClick={() => setSelected(s)} className="flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-gray-900">{s.subject.title}</span>
                  <span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-lg">{s.subject.code}</span>
                  <span className="text-xs text-gray-500">· {s.name}</span>
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-500">
                  <CalendarRange size={13} /><span>{s.semester.name}</span><span>·</span>
                  <span>{s.instructor.fullName}</span><span>·</span>
                  <Users size={13} /><span>{s._count?.enrollments || 0} enrolled</span>
                </div>
              </button>
              <div className="flex items-center gap-3">
                <button onClick={() => remove(s.id)} className="text-gray-400 hover:text-red-500 transition-colors"><Trash2 size={16} /></button>
                <ChevronRight size={18} className="text-gray-300 cursor-pointer" onClick={() => setSelected(s)} />
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <Modal onClose={() => { setOpen(false); setError(null); }} title="New Section">
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            {error && <ErrorBox>{error}</ErrorBox>}
            <Field label="Subject">
              <select required className={selectClass} value={form.subjectId} onChange={(e) => setForm((p) => ({ ...p, subjectId: e.target.value }))}>
                <option value="">Choose subject...</option>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.title}</option>)}
              </select>
            </Field>
            <Field label="Instructor">
              <select required className={selectClass} value={form.instructorId} onChange={(e) => setForm((p) => ({ ...p, instructorId: e.target.value }))}>
                <option value="">Choose instructor...</option>
                {instructors.map((i) => <option key={i.id} value={i.id}>{i.fullName}</option>)}
              </select>
            </Field>
            <Field label="Semester">
              <select required className={selectClass} value={form.semesterId} onChange={(e) => setForm((p) => ({ ...p, semesterId: e.target.value }))}>
                <option value="">Choose semester...</option>
                {semesters.map((s) => <option key={s.id} value={s.id}>{s.name}{s.isActive ? ' (active)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Section name"><input required placeholder="e.g. BSIT 3A" className={inputClass} value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} /></Field>
            <div className="flex gap-3 justify-end mt-2">
              <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200">Cancel</button>
              <button type="submit" disabled={saving} className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">{saving && <Loader2 size={14} className="animate-spin" />} Create</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function SectionDetail({ section, onBack }) {
  const [enrolled, setEnrolled] = useState([]);
  const [status, setStatus] = useState('IN_PROGRESS');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [gbKey, setGbKey] = useState(0);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockReason, setUnlockReason] = useState('');

  const refreshEnrolled = useCallback(async () => {
    const { data } = await gradingService.getGradebook(section.id);
    setEnrolled(data.students);
    setStatus(data.students[0]?.gradeStatus ?? 'IN_PROGRESS');
    setGbKey((k) => k + 1);
  }, [section.id]);

  useEffect(() => { refreshEnrolled(); }, [refreshEnrolled]);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!query.trim()) { setResults([]); return; }
      setSearching(true);
      try {
        const { data } = await gradingService.searchStudents(query.trim());
        const enrolledIds = new Set(enrolled.map((e) => e.studentId));
        setResults(data.filter((s) => !enrolledIds.has(s.id)));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, enrolled]);

  async function enroll(studentId) {
    await gradingService.enrollStudent(section.id, studentId);
    setQuery('');
    setResults([]);
    await refreshEnrolled();
  }
  async function unenroll(studentId) {
    await gradingService.unenrollStudent(section.id, studentId);
    await refreshEnrolled();
  }
  async function lock() {
    if (!confirm('Lock this section? Grades become official and read-only to the instructor.')) return;
    await gradingService.lockSection(section.id);
    await refreshEnrolled();
  }
  async function confirmUnlock() {
    if (!unlockReason.trim()) return;
    await gradingService.unlockSection(section.id, unlockReason.trim());
    setUnlockOpen(false);
    setUnlockReason('');
    await refreshEnrolled();
  }

  const inputClass = 'w-full bg-gray-50 border border-gray-200 rounded-xl pl-9 pr-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none';

  return (
    <div className="flex flex-col gap-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 w-fit">
        <ArrowLeft size={15} /> Back to sections
      </button>

      <div className="flex items-center justify-between bg-white border border-gray-200 rounded-2xl p-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-gray-900">{section.subject.title}</span>
            <span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-lg">{section.subject.code}</span>
            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>
          </div>
          <p className="text-xs text-gray-500 mt-1.5">{section.name} · {section.semester.name} · {section.instructor.fullName}</p>
        </div>
        {status === 'LOCKED' ? (
          <button onClick={() => setUnlockOpen(true)} className="inline-flex items-center gap-1.5 text-sm text-amber-600 hover:bg-amber-50 px-3 py-1.5 rounded-xl border border-amber-200"><Unlock size={15} /> Unlock</button>
        ) : (
          <button onClick={lock} className="inline-flex items-center gap-1.5 text-sm text-purple-600 hover:bg-purple-50 px-3 py-1.5 rounded-xl border border-purple-200"><Lock size={15} /> Lock grades</button>
        )}
      </div>

      {/* Enrollment */}
      <div className="bg-white border border-gray-200 rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2"><UserPlus size={16} /> Enrollment ({enrolled.length})</h3>
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input className={inputClass} placeholder="Search students by name or email to enroll..." value={query} onChange={(e) => setQuery(e.target.value)} />
          {searching && <Loader2 size={15} className="animate-spin absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />}
        </div>
        {results.length > 0 && (
          <div className="flex flex-col gap-1 mb-3 border border-gray-200 rounded-xl p-2">
            {results.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-2 py-1.5 hover:bg-gray-50 rounded-lg">
                <div><p className="text-sm text-gray-800">{s.fullName}</p><p className="text-xs text-gray-400">{s.email || s.username}</p></div>
                <button onClick={() => enroll(s.id)} className="text-xs inline-flex items-center gap-1 text-blue-600 hover:underline"><Plus size={13} /> Enroll</button>
              </div>
            ))}
          </div>
        )}
        {enrolled.length === 0 ? (
          <p className="text-sm text-gray-400">No students enrolled yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {enrolled.map((e) => (
              <span key={e.enrollmentId} className="inline-flex items-center gap-2 text-sm bg-gray-50 border border-gray-200 rounded-xl px-3 py-1.5">
                {e.student.fullName}
                {status === 'IN_PROGRESS' && <button onClick={() => unenroll(e.studentId)} className="text-gray-400 hover:text-red-500"><X size={13} /></button>}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Read-only gradebook */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Gradebook (read-only)</h3>
        <GradebookView key={gbKey} sectionId={section.id} readOnly />
      </div>

      {unlockOpen && (
        <Modal onClose={() => { setUnlockOpen(false); setUnlockReason(''); }} title="Unlock section">
          <p className="text-sm text-gray-500 mb-4">Unlocking returns grades to the instructor for editing. A reason is recorded in the audit log.</p>
          <textarea required rows={3} placeholder="Reason for unlocking..." className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none" value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} />
          <div className="flex gap-3 justify-end mt-4">
            <button onClick={() => { setUnlockOpen(false); setUnlockReason(''); }} className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200">Cancel</button>
            <button onClick={confirmUnlock} disabled={!unlockReason.trim()} className="px-4 py-2 rounded-xl text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50">Unlock</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
