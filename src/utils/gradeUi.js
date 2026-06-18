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
  if (isInc) return 'text-zinc-500 dark:text-zinc-400';
  if (gp == null) return 'text-zinc-400';
  if (gp <= 2.0) return 'text-emerald-600 dark:text-emerald-400';
  if (gp <= 3.0) return 'text-blue-600 dark:text-blue-400';
  return 'text-red-600 dark:text-red-400';
}

/** Badge styles keyed by remark string. */
export const REMARK_STYLE = {
  PASSED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  FAILED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  INC: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  'IN PROGRESS': 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

/** Badge styles keyed by enrollment grade status. */
export const STATUS_STYLE = {
  IN_PROGRESS: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  SUBMITTED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  LOCKED: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
};

export const STATUS_LABEL = {
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  LOCKED: 'Locked',
};
