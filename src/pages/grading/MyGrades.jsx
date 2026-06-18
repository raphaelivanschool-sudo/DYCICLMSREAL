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
          <h1 className="text-2xl font-semibold text-gray-900">My Grades</h1>
        </div>
        <p className="text-sm text-gray-500 ml-9">Your academic performance, by semester</p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-4">{[1, 2].map((i) => <div key={i} className="animate-pulse bg-gray-100 rounded-2xl h-28" />)}</div>
      ) : !hasAny ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <ClipboardList size={40} className="text-gray-300 mb-4" />
          <p className="text-base font-medium text-gray-500">No grades available yet</p>
          <p className="text-sm text-gray-400 mt-1">Your instructor has not entered any grades for you yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {semesters.map((sem) => (
            <div key={sem.semester.id}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 text-gray-700">
                  <CalendarRange size={16} className="text-gray-400" />
                  <span className="font-semibold">{sem.semester.name}</span>
                </div>
                <div className="inline-flex items-center gap-2 bg-gray-100 px-3 py-1.5 rounded-xl text-sm">
                  <span className="text-gray-400">GWA:</span>
                  <span className={`font-semibold font-mono ${gradeColor(sem.gwa)}`}>{sem.gwa != null ? sem.gwa.toFixed(2) : '—'}</span>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {sem.subjects.map((sub) => {
                  const isOpen = expanded[sub.enrollmentId];
                  return (
                    <div key={sub.enrollmentId} className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
                      <button onClick={() => toggle(sub.enrollmentId)} className="w-full flex items-center justify-between p-5 text-left hover:bg-gray-50 transition-colors">
                        <div className="flex items-center gap-3">
                          {isOpen ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-gray-900">{sub.subject.title}</span>
                              <span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-lg">{sub.subject.code}</span>
                            </div>
                            <p className="text-xs text-gray-400 mt-1">{sub.instructor} · {sub.sectionName} · {sub.subject.units} units</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_STYLE[sub.gradeStatus]}`}>{STATUS_LABEL[sub.gradeStatus]}</span>
                          <div className="text-right">
                            <p className={`text-xl font-bold font-mono ${gradeColor(sub.displayGradePoint, sub.isInc)}`}>{fmtGrade(sub.displayGradePoint, sub.isInc)}</p>
                            <p className="text-[10px] uppercase tracking-wide text-gray-400">{sub.finalized ? 'Final' : 'Running'}</p>
                          </div>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="border-t border-gray-200 p-5 bg-gray-50/50">
                          <div className="flex items-center justify-between mb-4 text-sm">
                            <span className="text-gray-500">Overall: <span className="font-mono text-gray-700">{fmtPct(sub.displayPercentage)}</span></span>
                            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${REMARK_STYLE[sub.remark] || ''}`}>{sub.remark}</span>
                          </div>
                          {sub.breakdown.length === 0 ? (
                            <p className="text-sm text-gray-400">Your instructor has not set up graded categories yet.</p>
                          ) : (
                            <div className="flex flex-col gap-4">
                              {sub.breakdown.map((cat) => (
                                <div key={cat.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
                                    <span className="text-sm font-medium text-gray-700">{cat.name} <span className="text-xs text-gray-400">({cat.weight}%)</span></span>
                                    <span className="text-sm font-mono text-gray-500">{fmtPct(cat.percentage)}</span>
                                  </div>
                                  {cat.activities.length === 0 ? (
                                    <p className="px-4 py-3 text-xs text-gray-400">No activities yet.</p>
                                  ) : (
                                    <table className="w-full text-sm">
                                      <tbody>
                                        {cat.activities.map((a) => (
                                          <tr key={a.id} className="border-b border-gray-50 last:border-0">
                                            <td className="px-4 py-2.5 text-gray-700">
                                              {a.title}
                                              {a.feedback && (
                                                <span className="inline-flex items-center gap-1 ml-2 text-xs text-blue-600" title={a.feedback}><MessageSquareText size={12} /> feedback</span>
                                              )}
                                              {a.feedback && <p className="text-xs text-gray-400 mt-0.5 italic">“{a.feedback}”</p>}
                                            </td>
                                            <td className="px-4 py-2.5 text-right font-mono whitespace-nowrap">
                                              {a.graded ? (
                                                <span className="text-gray-700">{a.rawScore} <span className="text-gray-400">/ {a.maxScore}</span></span>
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
