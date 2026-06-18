/**
 * Idempotent seed for the grading module defaults:
 *   - one active Semester (so the admin UI is usable immediately)
 *   - the default transmutation scale (3.00 floor at 75%, <75% -> 5.00, no 4.00)
 *
 * Safe to run multiple times. Run with:  node prisma/seed-grading.cjs
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEFAULT_GRADE_SCALE = [
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

async function main() {
  // Default active semester.
  const semesterCount = await prisma.semester.count();
  if (semesterCount === 0) {
    const sem = await prisma.semester.create({
      data: { name: '1st Sem AY 2025-2026', isActive: true },
    });
    console.log('Created default semester:', sem.name);
  } else {
    console.log('Semesters already exist — skipping.');
  }

  // Default transmutation scale.
  const scaleCount = await prisma.gradeScale.count();
  if (scaleCount === 0) {
    await prisma.gradeScale.createMany({ data: DEFAULT_GRADE_SCALE });
    console.log(`Seeded default grade scale (${DEFAULT_GRADE_SCALE.length} rows).`);
  } else {
    console.log('Grade scale already configured — skipping.');
  }

  console.log('Grading seed complete.');
}

main()
  .catch((e) => {
    console.error('Grading seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
