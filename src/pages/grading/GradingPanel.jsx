import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { GraduationCap } from 'lucide-react';
import { getUser } from '../../utils/auth';
import SemesterManager from './SemesterManager';
import SubjectManager from './SubjectManager';
import SectionsManager from './SectionsManager';
import GradeScaleManager from './GradeScaleManager';
import GradingReports from './GradingReports';
import AuditLogViewer from './AuditLogViewer';
import InstructorGradebook from './InstructorGradebook';

// Layout/shape only — active/inactive colors come from the shared Tabs component
// (light theme: white active chip on a gray-100 bar), so they stay native to the app.
const tabClass = 'px-5 py-2 rounded-lg text-sm font-medium';

export default function GradingPanel() {
  const user = getUser();
  const isAdmin = user?.role?.toLowerCase() === 'admin';

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <GraduationCap size={22} className="text-blue-600" />
          <h1 className="text-2xl font-semibold text-gray-900">Grading</h1>
        </div>
        <p className="text-sm text-gray-500 ml-9">
          {isAdmin
            ? 'Set up semesters, subjects, sections and the grading scale; oversee and lock grades'
            : 'Manage your sections, enter scores and submit final grades'}
        </p>
      </div>

      {isAdmin ? (
        <Tabs defaultValue="sections">
          <TabsList className="flex flex-wrap gap-1 h-auto rounded-xl mb-8">
            <TabsTrigger value="sections" className={tabClass}>Sections</TabsTrigger>
            <TabsTrigger value="subjects" className={tabClass}>Subjects</TabsTrigger>
            <TabsTrigger value="semesters" className={tabClass}>Semesters</TabsTrigger>
            <TabsTrigger value="scale" className={tabClass}>Grade Scale</TabsTrigger>
            <TabsTrigger value="reports" className={tabClass}>Reports</TabsTrigger>
            <TabsTrigger value="audit" className={tabClass}>Audit Log</TabsTrigger>
          </TabsList>

          <TabsContent value="sections" className="min-h-[400px]"><SectionsManager /></TabsContent>
          <TabsContent value="subjects" className="min-h-[400px]"><SubjectManager /></TabsContent>
          <TabsContent value="semesters" className="min-h-[400px]"><SemesterManager /></TabsContent>
          <TabsContent value="scale" className="min-h-[400px]"><GradeScaleManager /></TabsContent>
          <TabsContent value="reports" className="min-h-[400px]"><GradingReports /></TabsContent>
          <TabsContent value="audit" className="min-h-[400px]"><AuditLogViewer /></TabsContent>
        </Tabs>
      ) : (
        <InstructorGradebook />
      )}
    </div>
  );
}
