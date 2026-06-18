// Shared display helpers for the per-semester 1.00–5.00 grading model.

/** Format a grade point for display, or a dash when not yet computed. */
export function fmtGrade(gp, isInc) {
  if (isInc) return 'INC';
  if (gp == null) return '—';
  return Number(gp).toFixed(2);
}

/** Format a percentage. */
export function fmtPct(p) {
  if (p == null) return '—';
  return `${Number(p).toFixed(2)}%`;
}

/** Tailwind text color for a grade point (lower = better; 3.00 floor passing). */
export function gradeColor(gp, isInc) {
  if (isInc) return 'text-gray-500';
  if (gp == null) return 'text-gray-400';
  if (gp <= 2.0) return 'text-emerald-600';
  if (gp <= 3.0) return 'text-blue-600';
  return 'text-red-600';
}

/** Badge styles keyed by remark string. */
export const REMARK_STYLE = {
  PASSED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
  INC: 'bg-amber-100 text-amber-700',
  'IN PROGRESS': 'bg-gray-100 text-gray-500',
};

/** Badge styles keyed by enrollment grade status. */
export const STATUS_STYLE = {
  IN_PROGRESS: 'bg-gray-100 text-gray-600',
  SUBMITTED: 'bg-blue-100 text-blue-700',
  LOCKED: 'bg-purple-100 text-purple-700',
};

export const STATUS_LABEL = {
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  LOCKED: 'Locked',
};
