import { useState, useEffect } from 'react';
import { gradingService } from '../../services/gradingService';
import { ArrowLeft, BookOpen, Users, ChevronRight, CalendarRange } from 'lucide-react';
import GradebookView from './GradebookView';

export default function InstructorGradebook() {
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { data } = await gradingService.getSections();
      setSections(data);
    } finally {
      setLoading(false);
    }
  }

  if (selected) {
    return (
      <div className="flex flex-col gap-5">
        <button onClick={() => { setSelected(null); load(); }} className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 w-fit">
          <ArrowLeft size={15} /> Back to my sections
        </button>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{selected.subject.title}</span>
            <span className="font-mono text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-lg">{selected.subject.code}</span>
          </div>
          <p className="text-xs text-zinc-500 mt-1.5">{selected.name} · {selected.semester.name}</p>
        </div>
        <GradebookView sectionId={selected.id} onSubmitted={() => {}} />
      </div>
    );
  }

  return (
    <div>
      {loading ? (
        <div className="flex flex-col gap-4">{[1, 2, 3].map((i) => <div key={i} className="animate-pulse bg-zinc-100 dark:bg-zinc-800 rounded-2xl h-20" />)}</div>
      ) : sections.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <BookOpen size={40} className="text-zinc-300 dark:text-zinc-600 mb-4" />
          <p className="text-base font-medium text-zinc-500">No sections assigned</p>
          <p className="text-sm text-zinc-400 mt-1">An administrator assigns you sections to grade.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="inline-flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 rounded-xl text-sm text-zinc-600 dark:text-zinc-300 w-fit">
            <BookOpen size={15} /> {sections.length} section{sections.length !== 1 ? 's' : ''}
          </div>
          {sections.map((s) => (
            <button key={s.id} onClick={() => setSelected(s)} className="flex items-center justify-between bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 text-left hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{s.subject.title}</span>
                  <span className="font-mono text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-lg">{s.subject.code}</span>
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-xs text-zinc-500">
                  <span>{s.name}</span><span>·</span>
                  <CalendarRange size={13} /><span>{s.semester.name}</span><span>·</span>
                  <Users size={13} /><span>{s._count?.enrollments || 0} student{(s._count?.enrollments || 0) !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <ChevronRight size={18} className="text-zinc-300" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
