import { useState, useEffect } from 'react';
import { gradingService } from '../../services/gradingService';
import { BarChart3, Download, Loader2, FileText } from 'lucide-react';
import { fmtGrade, fmtPct, gradeColor, REMARK_STYLE } from '../../utils/gradeUi';

function downloadCsv(filename, headers, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function GradingReports() {
  const [semesters, setSemesters] = useState([]);
  const [sections, setSections] = useState([]);
  const [semId, setSemId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [semReport, setSemReport] = useState(null);
  const [secReport, setSecReport] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    gradingService.getSemesters().then(({ data }) => {
      setSemesters(data);
      const active = data.find((s) => s.isActive) || data[0];
      if (active) setSemId(String(active.id));
    });
  }, []);

  async function loadSemester(id) {
    setLoading(true);
    setSectionId('');
    setSecReport(null);
    try {
      const [rep, secs] = await Promise.all([
        gradingService.getSemesterReport(id),
        gradingService.getSections(id),
      ]);
      setSemReport(rep.data);
      setSections(secs.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!semId) return;
    loadSemester(semId);
  }, [semId]);

  useEffect(() => {
    if (!sectionId) return;
    gradingService.getSectionReport(sectionId).then(({ data }) => setSecReport(data));
  }, [sectionId]);

  const selectClass = 'bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none';

  function exportSemester() {
    if (!semReport) return;
    downloadCsv(
      `semester-${semReport.semester.name}-gwa.csv`,
      ['Student', 'Subjects', 'INC', 'GWA'],
      semReport.students.map((s) => [s.student, s.subjects, s.inc, s.gwa ?? '']),
    );
  }
  function exportSection() {
    if (!secReport) return;
    downloadCsv(
      `${secReport.section.subject.code}-${secReport.section.name}-grades.csv`,
      ['Student', 'Email', 'Percentage', 'Grade', 'Remark', 'Status'],
      secReport.rows.map((r) => [r.student, r.email, r.percentage ?? '', r.isInc ? 'INC' : (r.gradePoint ?? ''), r.remark, r.status]),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3 flex-wrap">
        <BarChart3 size={18} className="text-blue-600" />
        <select className={selectClass} value={semId} onChange={(e) => setSemId(e.target.value)}>
          <option value="">Select semester...</option>
          {semesters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {loading && <div className="animate-pulse bg-zinc-100 dark:bg-zinc-800 rounded-2xl h-40" />}

      {semReport && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Total grades" value={semReport.summary.total} />
            <StatCard label="Passed" value={semReport.summary.passed} color="text-emerald-600 dark:text-emerald-400" />
            <StatCard label="Failed" value={semReport.summary.failed} color="text-red-600 dark:text-red-400" />
            <StatCard label="INC" value={semReport.summary.inc} color="text-amber-600 dark:text-amber-400" />
          </div>

          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Per-student GWA</h3>
              <button onClick={exportSemester} className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"><Download size={14} /> Export CSV</button>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-800">
                  {['Student', 'Subjects', 'INC', 'GWA'].map((h) => <th key={h} className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {semReport.students.length === 0 ? (
                  <tr><td colSpan={4} className="px-5 py-10 text-center text-sm text-zinc-400">No enrollments in this semester.</td></tr>
                ) : semReport.students.map((s) => (
                  <tr key={s.studentId} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                    <td className="px-5 py-3 font-medium text-zinc-900 dark:text-zinc-100">{s.student}</td>
                    <td className="px-5 py-3 text-zinc-500">{s.subjects}</td>
                    <td className="px-5 py-3 text-zinc-500">{s.inc}</td>
                    <td className={`px-5 py-3 font-mono font-semibold ${gradeColor(s.gwa)}`}>{s.gwa != null ? s.gwa.toFixed(2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Section grade sheet */}
          <div className="flex items-center gap-3 flex-wrap">
            <FileText size={18} className="text-blue-600" />
            <select className={selectClass} value={sectionId} onChange={(e) => { setSectionId(e.target.value); if (!e.target.value) setSecReport(null); }}>
              <option value="">Section grade sheet...</option>
              {sections.map((s) => <option key={s.id} value={s.id}>{s.subject.code} — {s.name}</option>)}
            </select>
          </div>

          {secReport && (
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{secReport.section.subject.code} — {secReport.section.name}</h3>
                  <p className="text-xs text-zinc-400 mt-0.5">{secReport.section.instructor} · {secReport.summary.passed} passed · {secReport.summary.failed} failed · {secReport.summary.inc} INC</p>
                </div>
                <button onClick={exportSection} className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"><Download size={14} /> Export CSV</button>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-800">
                    {['Student', 'Percentage', 'Grade', 'Remark', 'Status'].map((h) => <th key={h} className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {secReport.rows.length === 0 ? (
                    <tr><td colSpan={5} className="px-5 py-10 text-center text-sm text-zinc-400">No students enrolled.</td></tr>
                  ) : secReport.rows.map((r) => (
                    <tr key={r.studentId} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                      <td className="px-5 py-3 font-medium text-zinc-900 dark:text-zinc-100">{r.student}</td>
                      <td className="px-5 py-3 font-mono text-zinc-500">{fmtPct(r.percentage)}</td>
                      <td className={`px-5 py-3 font-mono font-semibold ${gradeColor(r.gradePoint, r.isInc)}`}>{fmtGrade(r.gradePoint, r.isInc)}</td>
                      <td className="px-5 py-3"><span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${REMARK_STYLE[r.remark] || ''}`}>{r.remark}</span></td>
                      <td className="px-5 py-3 text-xs text-zinc-500">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, color = 'text-zinc-900 dark:text-zinc-100' }) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-400 mb-1">{label}</p>
      <p className={`text-2xl font-semibold font-mono ${color}`}>{value}</p>
    </div>
  );
}
