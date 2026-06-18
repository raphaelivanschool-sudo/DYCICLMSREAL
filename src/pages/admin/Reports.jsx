import ReportDownloader from '../../components/reports/ReportDownloader';

const ADMIN_REPORTS = [
  {
    key: 'lab-utilization',
    endpoint: 'lab-utilization',
    label: 'Lab / PC Utilization',
    description: 'Online minutes, sessions, first/last seen per PC and day. From agent presence history.',
    filters: [{ key: 'labId', label: 'Lab ID', placeholder: 'Lab ID (optional)' }],
  },
  {
    key: 'control-actions',
    endpoint: 'control-actions',
    label: 'Control Action Log',
    description: 'Every lock / shutdown / restart / project / Wi-Fi / website-block / wake command with actor, target, and result.',
  },
  {
    key: 'login-activity',
    endpoint: 'login-activity',
    label: 'Login / Session Activity',
    description: 'Logins, logouts, and failed attempts with user, role, IP, and success/fail.',
    filters: [{ key: 'username', label: 'Username', placeholder: 'Username (optional)' }],
  },
  {
    key: 'tickets',
    endpoint: 'tickets',
    label: 'Tickets / Support',
    description: 'Tickets created in range with requester, category, status, assignee, and resolution time.',
  },
  {
    key: 'inventory',
    endpoint: 'inventory',
    label: 'PC Inventory / Status',
    description: 'Current snapshot of every PC: hostname, IP, MAC, status, last seen, specs, and lab room.',
  },
];

export default function Reports() {
  return (
    <ReportDownloader
      title="Usage Reports"
      description="Download institution-wide system-usage reports as CSV. Pick a date range, then download. Empty ranges produce a header-only file."
      reports={ADMIN_REPORTS}
    />
  );
}
