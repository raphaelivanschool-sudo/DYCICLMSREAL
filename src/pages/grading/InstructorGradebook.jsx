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
        <button onClick={() => { setSelected(null); load(); }} className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 w-fit">
          <ArrowLeft size={15} /> Back to my sections
        </button>
        <div className="bg-white border border-gray-200 rounded-2xl p-5">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-gray-900">{selected.subject.title}</span>
            <span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-lg">{selected.subject.code}</span>
          </div>
          <p className="text-xs text-gray-500 mt-1.5">{selected.name} · {selected.semester.name}</p>
        </div>
        <GradebookView sectionId={selected.id} onSubmitted={() => {}} />
      </div>
    );
  }

  return (
    <div>
      {loading ? (
        <div className="flex flex-col gap-4">{[1, 2, 3].map((i) => <div key={i} className="animate-pulse bg-gray-100 rounded-2xl h-20" />)}</div>
      ) : sections.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <BookOpen size={40} className="text-gray-300 mb-4" />
          <p className="text-base font-medium text-gray-500">No sections assigned</p>
          <p className="text-sm text-gray-400 mt-1">An administrator assigns you sections to grade.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="inline-flex items-center gap-2 bg-gray-100 px-3 py-1.5 rounded-xl text-sm text-gray-600 w-fit">
            <BookOpen size={15} /> {sections.length} section{sections.length !== 1 ? 's' : ''}
          </div>
          {sections.map((s) => (
            <button key={s.id} onClick={() => setSelected(s)} className="flex items-center justify-between bg-white border border-gray-200 rounded-2xl p-5 text-left hover:border-gray-300 transition-colors">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-gray-900">{s.subject.title}</span>
                  <span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-lg">{s.subject.code}</span>
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-500">
                  <span>{s.name}</span><span>·</span>
                  <CalendarRange size={13} /><span>{s.semester.name}</span><span>·</span>
                  <Users size={13} /><span>{s._count?.enrollments || 0} student{(s._count?.enrollments || 0) !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <ChevronRight size={18} className="text-gray-300" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
