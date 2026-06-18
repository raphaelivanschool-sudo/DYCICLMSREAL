/**
 * Transmutation engine for the per-semester 1.00–5.00 grading model.
 *
 * Rules (DYCI):
 *   - 3.00 is the LOWEST passing grade (at 75%).
 *   - Below 75% transmutes to 5.00 (failed).
 *   - There is NO 4.00.
 *   - INC is a manual mark for incomplete requirements (handled on the Enrollment,
 *     not by this engine).
 *
 * The scale is DATA, not hard-coded: callers pass the admin-editable GradeScale
 * rows. A sensible default is provided for seeding / fallback.
 */

// Default seed table. REPLACE rows via the admin Grade Scale UI to match
// DYCI's official cutoffs. Note: no 4.00, <75 -> 5.00.
export const DEFAULT_GRADE_SCALE = [
  { minPercent: 97, maxPercent: 100, gradePoint: 1.0, label: 'Excellent' },
  { minPercent: 94, maxPercent: 96, gradePoint: 1.25, label: 'Excellent' },
  { minPercent: 91, maxPercent: 93, gradePoint: 1.5, label: 'Very Good' },
  { minPercent: 88, maxPercent: 90, gradePoint: 1.75, label: 'Very Good' },
  { minPercent: 85, maxPercent: 87, gradePoint: 2.0, label: 'Good' },
  { minPercent: 82, maxPercent: 84, gradePoint: 2.25, label: 'Good' },
  { minPercent: 79, maxPercent: 81, gradePoint: 2.5, label: 'Satisfactory' },
  { minPercent: 76, maxPercent: 78, gradePoint: 2.75, label: 'Satisfactory' },
  { minPercent: 75, maxPercent: 75, gradePoint: 3.0, label: 'Passing' },
  { minPercent: 0, maxPercent: 74.99, gradePoint: 5.0, label: 'Failed' },
];

/**
 * Round a number to 2 decimal places (avoids float noise like 89.99999).
 */
export function round2(n) {
  if (n == null || isNaN(n)) return null;
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Transmute a 0–100 percentage to a 1.00–5.00 grade point using the given scale.
 * @param {number|null} percent
 * @param {Array<{minPercent:number,maxPercent:number,gradePoint:number}>} scale
 * @returns {number|null} grade point, or null if percent is null
 */
export function transmute(percent, scale = DEFAULT_GRADE_SCALE) {
  if (percent == null || isNaN(percent)) return null;
  const clamped = Math.min(100, Math.max(0, Number(percent)));
  // Highest cutoff wins when ranges overlap on a boundary.
  const sorted = [...scale].sort((a, b) => b.minPercent - a.minPercent);
  const row = sorted.find((r) => clamped >= r.minPercent && clamped <= r.maxPercent);
  if (row) return row.gradePoint;
  // Fallback: anything not covered and below the lowest passing cutoff fails.
  return 5.0;
}

/**
 * Compute a section's weighted percentage for ONE enrollment from its scores.
 *
 * Structure expected:
 *   categories: [{ weight, activities: [{ maxScore, scores: [{ enrollmentId, rawScore }] }] }]
 *
 * Category % = sum(rawScore) / sum(maxScore) * 100, over activities that have a score.
 * Total %    = sum(category% * weight) / sum(weight of categories that have scores).
 *
 * Categories with no graded activity yet are excluded so the running grade reflects
 * only what has actually been graded.
 *
 * @returns {{ percentage:number|null, categoryBreakdown:Array, gradedWeight:number }}
 */
export function computeEnrollmentPercentage(categories, enrollmentId) {
  let weightedSum = 0;
  let gradedWeight = 0;
  const categoryBreakdown = [];

  for (const cat of categories) {
    let earned = 0;
    let possible = 0;
    let hasScore = false;

    for (const act of cat.activities || []) {
      const score = (act.scores || []).find((s) => s.enrollmentId === enrollmentId);
      if (score && score.rawScore != null) {
        earned += Number(score.rawScore);
        possible += Number(act.maxScore || 0);
        hasScore = true;
      }
    }

    const catPercent = hasScore && possible > 0 ? (earned / possible) * 100 : null;
    categoryBreakdown.push({
      categoryId: cat.id,
      name: cat.name,
      weight: cat.weight,
      earned: round2(earned),
      possible: round2(possible),
      percentage: round2(catPercent),
    });

    if (catPercent != null) {
      weightedSum += catPercent * Number(cat.weight);
      gradedWeight += Number(cat.weight);
    }
  }

  // Normalize by the graded weight so a partially-graded section still shows a
  // meaningful running grade (e.g. only Quizzes graded so far -> Quizzes %).
  const percentage = gradedWeight > 0 ? round2(weightedSum / gradedWeight) : null;
  return { percentage, categoryBreakdown, gradedWeight };
}

/**
 * Map a grade point to a remark string for display.
 */
export function remarkFor({ isInc, gradePoint }) {
  if (isInc) return 'INC';
  if (gradePoint == null) return 'IN PROGRESS';
  if (gradePoint <= 3.0) return 'PASSED';
  return 'FAILED';
}
