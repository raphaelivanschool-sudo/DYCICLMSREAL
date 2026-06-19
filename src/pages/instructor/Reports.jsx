import ReportDownloader from '../../components/reports/ReportDownloader';

const INSTRUCTOR_REPORTS = [
  {
    key: 'attendance',
    endpoint: 'attendance',
    label: 'Attendance via Agent Presence',
    description:
      'For your scheduled lab sessions: which PCs were online, for how long, and first/last seen. (Attendance is per PC/room — agents report a PC, not a student account.)',
  },
  {
    key: 'my-control-log',
    endpoint: 'my-control-log',
    label: 'My Control / Projection Log',
    description:
      'Every control command you issued, with target and result. Projection rows include duration in minutes.',
  },
];

export default function Reports() {
  return (
    <ReportDownloader
      title="Reports"
      description="Download CSV reports scoped to your own classes and actions. Pick a date range, then download."
      reports={INSTRUCTOR_REPORTS}
    />
  );
}
