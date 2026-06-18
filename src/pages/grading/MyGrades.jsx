import { useState, useEffect } from 'react';
import { gradingService } from '../../services/gradingService';
import { ClipboardList, ChevronDown, ChevronRight, CalendarRange, MessageSquareText } from 'lucide-react';
import { fmtGrade, fmtPct, gradeColor, REMARK_STYLE, STATUS_STYLE, STATUS_LABEL } from '../../utils/gradeUi';

export default function MyGrades() {
  const [semesters, setSemesters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    gradingService.getMyGrades()
      .then((r) => setSemesters(r.data))
      .finally(() => setLoading(false));
  }, []);

  const toggle = (id) => setExpanded((p) => ({ ...p, [id]: !p[id] }));
  const hasAny = semesters.some((s) => s.subjects.length > 0);

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <ClipboardList size={22} className="text-blue-600" />
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">My Grades</h1>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 ml-9">Your academic performance, by semester</p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-4">{[1, 2].map((i) => <div key={i} className="animate-pulse bg-zinc-100 dark:bg-zinc-800 rounded-2xl h-28" />)}</div>
      ) : !hasAny ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <ClipboardList size={40} className="text-zinc-300 dark:text-zinc-600 mb-4" />
          <p className="text-base font-medium text-zinc-500">No grades available yet</p>
          <p className="text-sm text-zinc-400 mt-1">Your instructor has not entered any grades for you yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {semesters.map((sem) => (
            <div key={sem.semester.id}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 text-zinc-700 dark:text-zinc-200">
                  <CalendarRange size={16} className="text-zinc-400" />
                  <span className="font-semibold">{sem.semester.name}</span>
                </div>
                <div className="inline-flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 rounded-xl text-sm">
                  <span className="text-zinc-400">GWA:</span>
                  <span className={`font-semibold font-mono ${gradeColor(sem.gwa)}`}>{sem.gwa != null ? sem.gwa.toFixed(2) : '—'}</span>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {sem.subjects.map((sub) => {
                  const isOpen = expanded[sub.enrollmentId];
                  return (
                    <div key={sub.enrollmentId} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
                      <button onClick={() => toggle(sub.enrollmentId)} className="w-full flex items-center justify-between p-5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
                        <div className="flex items-center gap-3">
                          {isOpen ? <ChevronDown size={16} className="text-zinc-400" /> : <ChevronRight size={16} className="text-zinc-400" />}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-zinc-900 dark:text-zinc-100">{sub.subject.title}</span>
                              <span className="font-mono text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-lg">{sub.subject.code}</span>
                            </div>
                            <p className="text-xs text-zinc-400 mt-1">{sub.instructor} · {sub.sectionName} · {sub.subject.units} units</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_STYLE[sub.gradeStatus]}`}>{STATUS_LABEL[sub.gradeStatus]}</span>
                          <div className="text-right">
                            <p className={`text-xl font-bold font-mono ${gradeColor(sub.displayGradePoint, sub.isInc)}`}>{fmtGrade(sub.displayGradePoint, sub.isInc)}</p>
                            <p className="text-[10px] uppercase tracking-wide text-zinc-400">{sub.finalized ? 'Final' : 'Running'}</p>
                          </div>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="border-t border-zinc-200 dark:border-zinc-800 p-5 bg-zinc-50/50 dark:bg-zinc-800/20">
                          <div className="flex items-center justify-between mb-4 text-sm">
                            <span className="text-zinc-500">Overall: <span className="font-mono text-zinc-700 dark:text-zinc-200">{fmtPct(sub.displayPercentage)}</span></span>
                            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${REMARK_STYLE[sub.remark] || ''}`}>{sub.remark}</span>
                          </div>
                          {sub.breakdown.length === 0 ? (
                            <p className="text-sm text-zinc-400">Your instructor has not set up graded categories yet.</p>
                          ) : (
                            <div className="flex flex-col gap-4">
                              {sub.breakdown.map((cat) => (
                                <div key={cat.id} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
                                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800">
                                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{cat.name} <span className="text-xs text-zinc-400">({cat.weight}%)</span></span>
                                    <span className="text-sm font-mono text-zinc-500">{fmtPct(cat.percentage)}</span>
                                  </div>
                                  {cat.activities.length === 0 ? (
                                    <p className="px-4 py-3 text-xs text-zinc-400">No activities yet.</p>
                                  ) : (
                                    <table className="w-full text-sm">
                                      <tbody>
                                        {cat.activities.map((a) => (
                                          <tr key={a.id} className="border-b border-zinc-50 dark:border-zinc-800/50 last:border-0">
                                            <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300">
                                              {a.title}
                                              {a.feedback && (
                                                <span className="inline-flex items-center gap-1 ml-2 text-xs text-blue-600 dark:text-blue-400" title={a.feedback}><MessageSquareText size={12} /> feedback</span>
                                              )}
                                              {a.feedback && <p className="text-xs text-zinc-400 mt-0.5 italic">“{a.feedback}”</p>}
                                            </td>
                                            <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap">
                                              {a.graded ? (
                                                <span className="text-zinc-700 dark:text-zinc-200">{a.rawScore} <span className="text-zinc-400">/ {a.maxScore}</span></span>
                                              ) : (
                                                <span className="text-xs text-amber-500">pending</span>
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
