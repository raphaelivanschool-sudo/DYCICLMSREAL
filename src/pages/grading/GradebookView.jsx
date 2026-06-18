import { useState, useEffect, useCallback } from 'react';
import { gradingService } from '../../services/gradingService';
import {
  Plus, Trash2, Loader2, Send, AlertCircle, MessageSquare, MessageSquareText,
  Lock, Users, TrendingUp, AlertTriangle, ListChecks,
} from 'lucide-react';
import { Modal, Field, ErrorBox } from './SemesterManager';
import { fmtGrade, fmtPct, gradeColor, REMARK_STYLE, STATUS_STYLE, STATUS_LABEL } from '../../utils/gradeUi';

function computeRemark(isInc, gp) {
  if (isInc) return 'INC';
  if (gp == null) return 'IN PROGRESS';
  if (gp <= 3.0) return 'PASSED';
  return 'FAILED';
}

export default function GradebookView({ sectionId, readOnly = false, onSubmitted }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scores, setScores] = useState({}); // `${activityId}:${enrollmentId}` -> string
  const [savingCell, setSavingCell] = useState(null);
  const [students, setStudents] = useState([]);

  // modals
  const [catModal, setCatModal] = useState(false);
  const [actModal, setActModal] = useState(null); // categoryId
  const [fbModal, setFbModal] = useState(null); // { activityId, enrollmentId, current }
  const [submitModal, setSubmitModal] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await gradingService.getGradebook(sectionId);
      setData(data);
      setStudents(data.students);
      const map = {};
      for (const cat of data.categories) {
        for (const act of cat.activities) {
          for (const sc of act.scores) {
            if (sc.rawScore != null) map[`${act.id}:${sc.enrollmentId}`] = String(sc.rawScore);
          }
        }
      }
      setScores(map);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load gradebook');
    } finally {
      setLoading(false);
    }
  }, [sectionId]);

  useEffect(() => { load(); }, [load]);

  const editable = data?.editable && !readOnly;

  function patchStudent(enrollment) {
    setStudents((prev) => prev.map((s) => s.enrollmentId === enrollment.id
      ? {
          ...s,
          runningPercentage: enrollment.finalPercentage,
          runningGradePoint: enrollment.gradePoint,
          isInc: enrollment.isInc,
          remark: computeRemark(enrollment.isInc, enrollment.gradePoint),
        }
      : s));
  }

  async function saveCell(activityId, enrollmentId, value) {
    setSavingCell(`${activityId}:${enrollmentId}`);
    setError(null);
    try {
      const { data: res } = await gradingService.saveScore(activityId, enrollmentId, { rawScore: value === '' ? null : value });
      patchStudent(res.enrollment);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to save score');
      await load();
    } finally {
      setSavingCell(null);
    }
  }

  async function addCategory(form) {
    setBusy(true);
    try {
      await gradingService.createCategory(sectionId, { name: form.name, weight: parseFloat(form.weight) });
      setCatModal(false);
      await load();
    } finally { setBusy(false); }
  }

  async function addActivity(categoryId, form) {
    setBusy(true);
    try {
      await gradingService.createActivity(categoryId, {
        title: form.title,
        maxScore: parseFloat(form.maxScore),
        dueDate: form.dueDate || null,
      });
      setActModal(null);
      await load();
    } finally { setBusy(false); }
  }

  async function removeCategory(id) {
    if (!confirm('Delete this category and its activities?')) return;
    await gradingService.deleteCategory(id);
    await load();
  }

  async function removeActivity(id) {
    if (!confirm('Delete this activity and its scores?')) return;
    await gradingService.deleteActivity(id);
    await load();
  }

  async function saveFeedback(text) {
    const { activityId, enrollmentId } = fbModal;
    setBusy(true);
    try {
      const current = scores[`${activityId}:${enrollmentId}`] ?? null;
      const { data: res } = await gradingService.saveScore(activityId, enrollmentId, { rawScore: current, feedback: text });
      patchStudent(res.enrollment);
      setData((prev) => {
        const next = structuredClone(prev);
        for (const cat of next.categories) {
          for (const act of cat.activities) {
            if (act.id === activityId) {
              const sc = act.scores.find((s) => s.enrollmentId === enrollmentId);
              if (sc) sc.feedback = text;
              else act.scores.push({ enrollmentId, rawScore: current != null ? parseFloat(current) : null, feedback: text });
            }
          }
        }
        return next;
      });
      setFbModal(null);
    } finally { setBusy(false); }
  }

  async function markInc(enrollmentId) {
    const res = await gradingService.markInc(enrollmentId);
    patchStudent(res.data);
  }
  async function resolveInc(enrollmentId) {
    const res = await gradingService.resolveInc(enrollmentId);
    patchStudent(res.data);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await gradingService.submitSection(sectionId);
      setSubmitModal(false);
      await load();
      onSubmitted?.();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to submit');
      setSubmitModal(false);
    } finally { setBusy(false); }
  }

  if (loading) return <div className="animate-pulse bg-gray-100 rounded-2xl h-64" />;
  if (!data) return <ErrorBox>{error || 'Gradebook unavailable'}</ErrorBox>;

  const weightOk = data.weightTotal === 100;
  const sectionStatus = students[0]?.gradeStatus ?? 'IN_PROGRESS';
  const fbFor = (activityId, enrollmentId) => {
    for (const cat of data.categories) for (const act of cat.activities) if (act.id === activityId) {
      return act.scores.find((s) => s.enrollmentId === enrollmentId)?.feedback || '';
    }
    return '';
  };

  const cellInput = `w-16 text-center rounded-lg px-1.5 py-1 text-sm font-mono bg-gray-50
    border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent
    focus:outline-none transition-all`;

  return (
    <div className="flex flex-col gap-5">
      {error && <ErrorBox>{error}</ErrorBox>}

      {/* Analytics + actions */}
      <div className="flex flex-wrap items-center gap-3">
        <Stat icon={<Users size={15} className="text-gray-400" />} label="Students" value={data.analytics.total} />
        <Stat icon={<TrendingUp size={15} className="text-gray-400" />} label="Class avg" value={fmtPct(data.analytics.classAverage)} />
        <Stat icon={<AlertTriangle size={15} className={data.analytics.failing > 0 ? 'text-red-500' : 'text-gray-400'} />} label="Failing" value={data.analytics.failing} danger={data.analytics.failing > 0} />
        <div className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium ${weightOk ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          <ListChecks size={15} /> Weights: {data.weightTotal}%{!weightOk && ' (must total 100)'}
        </div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_STYLE[sectionStatus]}`}>{STATUS_LABEL[sectionStatus]}</span>

        {editable && (
          <button onClick={() => setSubmitModal(true)} className="ml-auto inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-50">
            <Send size={15} /> Submit grades
          </button>
        )}
        {!editable && !readOnly && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-sm text-gray-500"><Lock size={14} /> Read-only ({STATUS_LABEL[sectionStatus]})</span>
        )}
      </div>

      {/* Category / activity setup (editable only) */}
      {editable && (
        <div className="bg-white border border-gray-200 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">Categories &amp; activities</h3>
            <button onClick={() => setCatModal(true)} className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:bg-blue-50 px-3 py-1.5 rounded-xl border border-blue-200 transition-colors">
              <Plus size={15} /> Add category
            </button>
          </div>
          {data.categories.length === 0 ? (
            <p className="text-sm text-gray-400">No categories yet. Add Class Standing, Quizzes, Major Exam, etc. (weights must total 100%).</p>
          ) : (
            <div className="flex flex-col gap-3">
              {data.categories.map((cat) => (
                <div key={cat.id} className="border border-gray-200 rounded-xl p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-800">{cat.name}</span>
                      <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-lg">{cat.weight}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setActModal(cat.id)} className="text-xs inline-flex items-center gap-1 text-blue-600 hover:underline"><Plus size={13} /> Activity</button>
                      <button onClick={() => removeCategory(cat.id)} className="text-gray-400 hover:text-red-500"><Trash2 size={14} /></button>
                    </div>
                  </div>
                  {cat.activities.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {cat.activities.map((a) => (
                        <span key={a.id} className="inline-flex items-center gap-1.5 text-xs bg-gray-50 border border-gray-200 rounded-lg px-2 py-1">
                          {a.title} <span className="text-gray-400">/{a.maxScore}</span>
                          <button onClick={() => removeActivity(a.id)} className="text-gray-400 hover:text-red-500"><Trash2 size={12} /></button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Grade grid */}
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-400 sticky left-0 bg-gray-50 min-w-[180px]">Student</th>
                {data.categories.map((cat) => cat.activities.map((a) => (
                  <th key={a.id} className="px-3 py-3 text-center text-xs font-medium text-gray-500 whitespace-nowrap" title={`${cat.name} • max ${a.maxScore}`}>
                    {a.title}<div className="text-[10px] text-gray-400 font-normal">/{a.maxScore}</div>
                  </th>
                )))}
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-400">Running %</th>
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-400">Grade</th>
                <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-400">Remark</th>
                {editable && <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-gray-400">INC</th>}
              </tr>
            </thead>
            <tbody>
              {students.length === 0 ? (
                <tr><td colSpan={99} className="px-4 py-12 text-center text-sm text-gray-400">No students enrolled in this section yet.</td></tr>
              ) : students.map((s) => (
                <tr key={s.enrollmentId} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 sticky left-0 bg-white min-w-[180px]">
                    <p className="font-medium text-gray-900">{s.student.fullName}</p>
                    <p className="text-xs text-gray-400">{s.student.email}</p>
                  </td>
                  {data.categories.map((cat) => cat.activities.map((a) => {
                    const key = `${a.id}:${s.enrollmentId}`;
                    const hasFb = !!fbFor(a.id, s.enrollmentId);
                    return (
                      <td key={a.id} className="px-3 py-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {editable ? (
                            <input
                              type="number" min="0" max={a.maxScore} step="0.01"
                              className={cellInput}
                              value={scores[key] ?? ''}
                              onChange={(e) => setScores((p) => ({ ...p, [key]: e.target.value }))}
                              onBlur={(e) => saveCell(a.id, s.enrollmentId, e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            />
                          ) : (
                            <span className="font-mono text-gray-700">{scores[key] ?? '—'}</span>
                          )}
                          {savingCell === key && <Loader2 size={12} className="animate-spin text-blue-500" />}
                          {(editable || hasFb) && (
                            <button onClick={() => setFbModal({ activityId: a.id, enrollmentId: s.enrollmentId, current: fbFor(a.id, s.enrollmentId) })} className={hasFb ? 'text-blue-500' : 'text-gray-300 hover:text-gray-500'} title={hasFb ? 'View/edit feedback' : 'Add feedback'} disabled={!editable && !hasFb}>
                              {hasFb ? <MessageSquareText size={13} /> : <MessageSquare size={13} />}
                            </button>
                          )}
                        </div>
                      </td>
                    );
                  }))}
                  <td className="px-4 py-3 text-center font-mono text-gray-600">{fmtPct(s.runningPercentage)}</td>
                  <td className={`px-4 py-3 text-center text-base font-semibold font-mono ${gradeColor(s.runningGradePoint, s.isInc)}`}>{fmtGrade(s.runningGradePoint, s.isInc)}</td>
                  <td className="px-4 py-3 text-center"><span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${REMARK_STYLE[s.remark] || ''}`}>{s.remark}</span></td>
                  {editable && (
                    <td className="px-4 py-3 text-center">
                      {s.isInc
                        ? <button onClick={() => resolveInc(s.enrollmentId)} className="text-xs text-amber-600 hover:underline">Resolve</button>
                        : <button onClick={() => markInc(s.enrollmentId)} className="text-xs text-gray-400 hover:text-amber-600">Mark INC</button>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modals */}
      {catModal && <CategoryModal busy={busy} onClose={() => setCatModal(false)} onSave={addCategory} />}
      {actModal && <ActivityModal busy={busy} onClose={() => setActModal(null)} onSave={(form) => addActivity(actModal, form)} />}
      {fbModal && <FeedbackModal busy={busy} initial={fbModal.current} readOnly={!editable} onClose={() => setFbModal(null)} onSave={saveFeedback} />}
      {submitModal && (
        <Modal onClose={() => setSubmitModal(false)} title="Submit final grades">
          <p className="text-sm text-gray-500 mb-4">
            This finalizes the computed grades for all {students.length} enrolled student(s) and locks the gradebook to you pending admin lock. Make sure category weights total 100%.
          </p>
          {!weightOk && <ErrorBox>Weights currently total {data.weightTotal}% — adjust before submitting.</ErrorBox>}
          <div className="flex gap-3 justify-end mt-4">
            <button onClick={() => setSubmitModal(false)} className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50">Cancel</button>
            <button onClick={submit} disabled={busy || !weightOk} className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
              {busy && <Loader2 size={14} className="animate-spin" />} Confirm submit
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Stat({ icon, label, value, danger }) {
  return (
    <div className="inline-flex items-center gap-2 bg-white border border-gray-200 px-3 py-2 rounded-xl text-sm">
      {icon}
      <span className="text-gray-400">{label}:</span>
      <span className={`font-semibold ${danger ? 'text-red-600' : 'text-gray-800'}`}>{value}</span>
    </div>
  );
}

function CategoryModal({ onClose, onSave, busy }) {
  const [form, setForm] = useState({ name: '', weight: '' });
  const inputClass = 'w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none';
  return (
    <Modal onClose={onClose} title="New category">
      <form onSubmit={(e) => { e.preventDefault(); onSave(form); }} className="flex flex-col gap-4">
        <Field label="Name"><input required placeholder="e.g. Class Standing" className={inputClass} value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} /></Field>
        <Field label="Weight (%)"><input required type="number" min="0" max="100" step="0.5" className={inputClass} value={form.weight} onChange={(e) => setForm((p) => ({ ...p, weight: e.target.value }))} /></Field>
        <div className="flex gap-3 justify-end mt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200">Cancel</button>
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">{busy && <Loader2 size={14} className="animate-spin" />} Add</button>
        </div>
      </form>
    </Modal>
  );
}

function ActivityModal({ onClose, onSave, busy }) {
  const [form, setForm] = useState({ title: '', maxScore: 100, dueDate: '' });
  const inputClass = 'w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none';
  return (
    <Modal onClose={onClose} title="New activity">
      <form onSubmit={(e) => { e.preventDefault(); onSave(form); }} className="flex flex-col gap-4">
        <Field label="Title"><input required placeholder="e.g. Quiz 1" className={inputClass} value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} /></Field>
        <Field label="Max score"><input required type="number" min="1" step="0.5" className={inputClass} value={form.maxScore} onChange={(e) => setForm((p) => ({ ...p, maxScore: e.target.value }))} /></Field>
        <Field label="Due date (optional)"><input type="date" className={inputClass} value={form.dueDate} onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))} /></Field>
        <div className="flex gap-3 justify-end mt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200">Cancel</button>
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">{busy && <Loader2 size={14} className="animate-spin" />} Add</button>
        </div>
      </form>
    </Modal>
  );
}

function FeedbackModal({ initial, onClose, onSave, busy, readOnly }) {
  const [text, setText] = useState(initial || '');
  const inputClass = 'w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none';
  return (
    <Modal onClose={onClose} title={readOnly ? 'Feedback' : 'Score feedback'}>
      {readOnly ? (
        <p className="text-sm text-gray-600 whitespace-pre-wrap">{text || 'No feedback.'}</p>
      ) : (
        <>
          <textarea rows={4} placeholder="Feedback for this score..." className={inputClass} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-3 justify-end mt-4">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200">Cancel</button>
            <button onClick={() => onSave(text)} disabled={busy} className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">{busy && <Loader2 size={14} className="animate-spin" />} Save</button>
          </div>
        </>
      )}
    </Modal>
  );
}
