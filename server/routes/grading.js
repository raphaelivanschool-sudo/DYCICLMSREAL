import express from 'express';
import { PrismaClient } from '@prisma/client';
import { recordActivity, clientIp } from '../utils/activityLog.js';
import {
  DEFAULT_GRADE_SCALE,
  transmute,
  round2,
  computeEnrollmentPercentage,
  remarkFor,
} from '../utils/transmutation.js';

const router = express.Router();
const prisma = new PrismaClient();

/* ============================================================
 * Helpers
 * ========================================================== */

const roleOf = (req) => req.user?.role?.toLowerCase();
const isAdmin = (req) => roleOf(req) === 'admin';
const isInstructor = (req) => roleOf(req) === 'instructor';
const isStudent = (req) => roleOf(req) === 'student';

function forbid(res, msg = 'Forbidden') {
  return res.status(403).json({ error: msg });
}

/** Read the admin-configured transmutation scale (falls back to the default). */
async function getActiveScale() {
  const rows = await prisma.gradeScale.findMany({ orderBy: { minPercent: 'desc' } });
  return rows.length ? rows : DEFAULT_GRADE_SCALE;
}

/** Append a grading audit entry (and mirror to the global system log). */
async function audit(req, { action, entityType, entityId, detail, oldValue, newValue, reason }) {
  try {
    await prisma.gradeAuditLog.create({
      data: {
        actorId: req.user?.id ?? null,
        action,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
        detail: detail ?? null,
        oldValue: oldValue != null ? String(oldValue) : null,
        newValue: newValue != null ? String(newValue) : null,
        reason: reason ?? null,
      },
    });
  } catch (e) {
    console.error('[grading audit]', e.message);
  }
  await recordActivity(prisma, {
    userId: req.user?.id,
    action: `GRADING_${action}`,
    description: detail || `${entityType || ''} ${entityId || ''}`.trim(),
    ipAddress: clientIp(req),
  });
}

/** Load a section and enforce write access (owning instructor; admin is read-only here). */
async function loadOwnedSection(req, sectionId, { includeEnrollments = true } = {}) {
  const section = await prisma.section.findUnique({
    where: { id: sectionId },
    include: { enrollments: includeEnrollments },
  });
  if (!section) return { error: 404 };
  if (isInstructor(req) && section.instructorId !== req.user.id) return { error: 403 };
  if (!isInstructor(req) && !isAdmin(req)) return { error: 403 };
  return { section };
}

/** A section is editable by the instructor while no enrollment is submitted/locked. */
function sectionEditable(section) {
  if (!section.enrollments || section.enrollments.length === 0) return true;
  return section.enrollments.every((e) => e.gradeStatus === 'IN_PROGRESS');
}

/** Recompute one enrollment's stored percentage + grade point from its scores. */
async function recomputeEnrollment(enrollmentId, scaleRows) {
  const enrollment = await prisma.enrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      section: {
        include: {
          categories: {
            include: {
              activities: { include: { scores: { where: { enrollmentId } } } },
            },
          },
        },
      },
    },
  });
  if (!enrollment) return null;
  const scale = scaleRows || (await getActiveScale());
  const { percentage } = computeEnrollmentPercentage(enrollment.section.categories, enrollmentId);
  const gradePoint = enrollment.isInc ? null : transmute(percentage, scale);
  return prisma.enrollment.update({
    where: { id: enrollmentId },
    data: { finalPercentage: percentage, gradePoint },
  });
}

/* ============================================================
 * PROMPT 1 — Foundation: Semesters, Subjects, Sections, Enrollments
 * ========================================================== */

// ---- Semesters ----
router.get('/semesters', async (req, res) => {
  try {
    const semesters = await prisma.semester.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { sections: true } } },
    });
    res.json(semesters);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/semesters', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const { name, isActive } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    if (isActive) await prisma.semester.updateMany({ data: { isActive: false } });
    const semester = await prisma.semester.create({
      data: { name: name.trim(), isActive: !!isActive },
    });
    await audit(req, { action: 'SEMESTER_CREATED', entityType: 'Semester', entityId: semester.id, detail: `Semester "${semester.name}"` });
    res.status(201).json(semester);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/semesters/:id', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const id = parseInt(req.params.id);
  const { name, isActive } = req.body;
  try {
    if (isActive) await prisma.semester.updateMany({ data: { isActive: false } });
    const semester = await prisma.semester.update({
      where: { id },
      data: {
        ...(name != null ? { name: String(name).trim() } : {}),
        ...(isActive != null ? { isActive: !!isActive } : {}),
      },
    });
    await audit(req, { action: 'SEMESTER_UPDATED', entityType: 'Semester', entityId: id, detail: `Semester "${semester.name}"` });
    res.json(semester);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Subjects ----
router.get('/subjects', async (req, res) => {
  try {
    const subjects = await prisma.subject.findMany({
      orderBy: { code: 'asc' },
      include: { _count: { select: { sections: true } } },
    });
    res.json(subjects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/subjects', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const { code, title, units } = req.body;
  if (!code?.trim() || !title?.trim()) {
    return res.status(400).json({ error: 'code and title are required' });
  }
  try {
    const existing = await prisma.subject.findUnique({ where: { code: code.trim() } });
    if (existing) return res.status(409).json({ error: 'A subject with this code already exists' });
    const subject = await prisma.subject.create({
      data: { code: code.trim(), title: title.trim(), units: units != null ? parseFloat(units) : 3 },
    });
    await audit(req, { action: 'SUBJECT_CREATED', entityType: 'Subject', entityId: subject.id, detail: `${subject.code} ${subject.title} (${subject.units}u)` });
    res.status(201).json(subject);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/subjects/:id', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const id = parseInt(req.params.id);
  const { code, title, units } = req.body;
  try {
    const subject = await prisma.subject.update({
      where: { id },
      data: {
        ...(code != null ? { code: String(code).trim() } : {}),
        ...(title != null ? { title: String(title).trim() } : {}),
        ...(units != null ? { units: parseFloat(units) } : {}),
      },
    });
    await audit(req, { action: 'SUBJECT_UPDATED', entityType: 'Subject', entityId: id, detail: `${subject.code} ${subject.title}` });
    res.json(subject);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Subject code already in use' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/subjects/:id', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const id = parseInt(req.params.id);
  try {
    const count = await prisma.section.count({ where: { subjectId: id } });
    if (count > 0) {
      return res.status(409).json({ error: 'Cannot delete: this subject has sections. Remove its sections first.' });
    }
    await prisma.subject.delete({ where: { id } });
    await audit(req, { action: 'SUBJECT_DELETED', entityType: 'Subject', entityId: id });
    res.json({ message: 'Subject deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Instructors (for section assignment) ----
router.get('/instructors', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  try {
    const instructors = await prisma.user.findMany({
      where: { role: 'INSTRUCTOR' },
      select: { id: true, fullName: true, email: true },
      orderBy: { fullName: 'asc' },
    });
    res.json(instructors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Sections ----
router.get('/sections', async (req, res) => {
  try {
    const { semesterId } = req.query;
    const where = {
      ...(semesterId ? { semesterId: parseInt(semesterId) } : {}),
      ...(isInstructor(req) ? { instructorId: req.user.id } : {}),
    };
    if (isStudent(req)) return forbid(res);
    const sections = await prisma.section.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        subject: true,
        semester: true,
        instructor: { select: { id: true, fullName: true } },
        _count: { select: { enrollments: true } },
      },
    });
    res.json(sections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sections', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const { name, subjectId, instructorId, semesterId, labScheduleId } = req.body;
  if (!name?.trim() || !subjectId || !instructorId || !semesterId) {
    return res.status(400).json({ error: 'name, subjectId, instructorId and semesterId are required' });
  }
  try {
    const section = await prisma.section.create({
      data: {
        name: name.trim(),
        subjectId: parseInt(subjectId),
        instructorId: parseInt(instructorId),
        semesterId: parseInt(semesterId),
        labScheduleId: labScheduleId ? parseInt(labScheduleId) : null,
      },
      include: { subject: true, semester: true, instructor: { select: { id: true, fullName: true } } },
    });
    await audit(req, { action: 'SECTION_CREATED', entityType: 'Section', entityId: section.id, detail: `${section.subject.code} — ${section.name} (${section.semester.name})` });
    res.status(201).json(section);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'A section with this subject, semester and name already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/sections/:id', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const id = parseInt(req.params.id);
  try {
    await prisma.section.delete({ where: { id } });
    await audit(req, { action: 'SECTION_DELETED', entityType: 'Section', entityId: id });
    res.json({ message: 'Section deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Students (search, for enrollment) ----
router.get('/students', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const { search } = req.query;
  try {
    const students = await prisma.user.findMany({
      where: {
        role: 'STUDENT',
        ...(search
          ? { OR: [{ fullName: { contains: search } }, { email: { contains: search } }, { username: { contains: search } }] }
          : {}),
      },
      select: { id: true, fullName: true, email: true, username: true },
      take: 30,
      orderBy: { fullName: 'asc' },
    });
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Enrollment ----
router.post('/sections/:id/enroll', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const sectionId = parseInt(req.params.id);
  const { studentId } = req.body;
  if (!studentId) return res.status(400).json({ error: 'studentId is required' });
  try {
    const student = await prisma.user.findFirst({
      where: { id: parseInt(studentId), role: 'STUDENT' },
      select: { id: true, fullName: true },
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const enrollment = await prisma.enrollment.upsert({
      where: { sectionId_studentId: { sectionId, studentId: student.id } },
      create: { sectionId, studentId: student.id },
      update: {},
      include: { student: { select: { id: true, fullName: true, email: true } } },
    });
    await audit(req, { action: 'STUDENT_ENROLLED', entityType: 'Enrollment', entityId: enrollment.id, detail: `Enrolled ${student.fullName} in section ${sectionId}` });
    res.status(201).json(enrollment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/sections/:id/enroll/:studentId', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const sectionId = parseInt(req.params.id);
  const studentId = parseInt(req.params.studentId);
  try {
    await prisma.enrollment.delete({
      where: { sectionId_studentId: { sectionId, studentId } },
    });
    await audit(req, { action: 'STUDENT_UNENROLLED', entityType: 'Enrollment', detail: `Unenrolled student ${studentId} from section ${sectionId}` });
    res.json({ message: 'Student unenrolled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
 * PROMPT 2 — Gradebook: categories, activities, scores, running grade
 * ========================================================== */

// Full gradebook for a section (owning instructor; admin read-only).
router.get('/sections/:id/gradebook', async (req, res) => {
  const sectionId = parseInt(req.params.id);
  try {
    const section = await prisma.section.findUnique({
      where: { id: sectionId },
      include: {
        subject: true,
        semester: true,
        instructor: { select: { id: true, fullName: true } },
        categories: {
          orderBy: { createdAt: 'asc' },
          include: { activities: { orderBy: { createdAt: 'asc' }, include: { scores: true } } },
        },
        enrollments: {
          include: { student: { select: { id: true, fullName: true, email: true } } },
          orderBy: { student: { fullName: 'asc' } },
        },
      },
    });
    if (!section) return res.status(404).json({ error: 'Section not found' });
    if (isInstructor(req) && section.instructorId !== req.user.id) return forbid(res);
    if (isStudent(req)) return forbid(res);

    const editable = sectionEditable(section);
    const weightTotal = round2(section.categories.reduce((s, c) => s + Number(c.weight), 0));

    // Per-student running grade + category breakdown.
    const scale = await getActiveScale();
    const students = section.enrollments.map((e) => {
      const { percentage, categoryBreakdown } = computeEnrollmentPercentage(section.categories, e.id);
      const gradePoint = e.isInc ? null : transmute(percentage, scale);
      return {
        enrollmentId: e.id,
        studentId: e.studentId,
        student: e.student,
        gradeStatus: e.gradeStatus,
        isInc: e.isInc,
        runningPercentage: percentage,
        runningGradePoint: gradePoint,
        finalPercentage: e.finalPercentage,
        finalGradePoint: e.gradePoint,
        remark: remarkFor({ isInc: e.isInc, gradePoint }),
        categoryBreakdown,
      };
    });

    // Light analytics.
    const graded = students.filter((s) => s.runningGradePoint != null);
    const failing = graded.filter((s) => s.runningGradePoint > 3.0).length;
    const classAverage = graded.length
      ? round2(graded.reduce((sum, s) => sum + s.runningPercentage, 0) / graded.length)
      : null;

    res.json({
      section: {
        id: section.id,
        name: section.name,
        subject: section.subject,
        semester: section.semester,
        instructor: section.instructor,
      },
      editable,
      weightTotal,
      categories: section.categories,
      students,
      analytics: { classAverage, failing, gradedCount: graded.length, total: students.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Categories ----
router.post('/sections/:id/categories', async (req, res) => {
  const sectionId = parseInt(req.params.id);
  const { name, weight } = req.body;
  if (!name?.trim() || weight == null) return res.status(400).json({ error: 'name and weight are required' });
  if (!isInstructor(req)) return forbid(res, 'Only the section instructor manages the gradebook');
  const { section, error } = await loadOwnedSection(req, sectionId);
  if (error) return res.status(error).json({ error: error === 404 ? 'Section not found' : 'Forbidden' });
  if (!sectionEditable(section)) return forbid(res, 'Grades submitted/locked — gradebook is read-only');
  try {
    const category = await prisma.gradeCategory.create({
      data: { sectionId, name: name.trim(), weight: parseFloat(weight) },
    });
    await audit(req, { action: 'CATEGORY_CREATED', entityType: 'GradeCategory', entityId: category.id, detail: `${category.name} (${category.weight}%) in section ${sectionId}` });
    res.status(201).json(category);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/categories/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, weight } = req.body;
  try {
    const existing = await prisma.gradeCategory.findUnique({ where: { id }, include: { section: { include: { enrollments: true } } } });
    if (!existing) return res.status(404).json({ error: 'Category not found' });
    if (isInstructor(req) && existing.section.instructorId !== req.user.id) return forbid(res);
    if (!isInstructor(req)) return forbid(res);
    if (!sectionEditable(existing.section)) return forbid(res, 'Grades submitted/locked — gradebook is read-only');
    const category = await prisma.gradeCategory.update({
      where: { id },
      data: { ...(name != null ? { name: String(name).trim() } : {}), ...(weight != null ? { weight: parseFloat(weight) } : {}) },
    });
    await audit(req, { action: 'CATEGORY_UPDATED', entityType: 'GradeCategory', entityId: id, detail: `${category.name} (${category.weight}%)` });
    res.json(category);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/categories/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const existing = await prisma.gradeCategory.findUnique({ where: { id }, include: { section: { include: { enrollments: true } } } });
    if (!existing) return res.status(404).json({ error: 'Category not found' });
    if (isInstructor(req) && existing.section.instructorId !== req.user.id) return forbid(res);
    if (!isInstructor(req)) return forbid(res);
    if (!sectionEditable(existing.section)) return forbid(res, 'Grades submitted/locked — gradebook is read-only');
    await prisma.gradeCategory.delete({ where: { id } });
    await audit(req, { action: 'CATEGORY_DELETED', entityType: 'GradeCategory', entityId: id });
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Activities ----
router.post('/categories/:id/activities', async (req, res) => {
  const categoryId = parseInt(req.params.id);
  const { title, maxScore, dueDate, labScheduleId } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
  try {
    const category = await prisma.gradeCategory.findUnique({ where: { id: categoryId }, include: { section: { include: { enrollments: true } } } });
    if (!category) return res.status(404).json({ error: 'Category not found' });
    if (isInstructor(req) && category.section.instructorId !== req.user.id) return forbid(res);
    if (!isInstructor(req)) return forbid(res);
    if (!sectionEditable(category.section)) return forbid(res, 'Grades submitted/locked — gradebook is read-only');
    const activity = await prisma.activity.create({
      data: {
        categoryId,
        title: title.trim(),
        maxScore: maxScore != null ? parseFloat(maxScore) : 100,
        dueDate: dueDate ? new Date(dueDate) : null,
        labScheduleId: labScheduleId ? parseInt(labScheduleId) : null,
      },
    });
    await audit(req, { action: 'ACTIVITY_CREATED', entityType: 'Activity', entityId: activity.id, detail: `${activity.title} (max ${activity.maxScore})` });
    res.status(201).json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/activities/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { title, maxScore, dueDate } = req.body;
  try {
    const existing = await prisma.activity.findUnique({ where: { id }, include: { category: { include: { section: { include: { enrollments: true } } } } } });
    if (!existing) return res.status(404).json({ error: 'Activity not found' });
    const section = existing.category.section;
    if (isInstructor(req) && section.instructorId !== req.user.id) return forbid(res);
    if (!isInstructor(req)) return forbid(res);
    if (!sectionEditable(section)) return forbid(res, 'Grades submitted/locked — gradebook is read-only');
    const activity = await prisma.activity.update({
      where: { id },
      data: {
        ...(title != null ? { title: String(title).trim() } : {}),
        ...(maxScore != null ? { maxScore: parseFloat(maxScore) } : {}),
        ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(dueDate) : null } : {}),
      },
    });
    // Score totals may shift if maxScore changed — recompute the section.
    if (maxScore != null) {
      const scale = await getActiveScale();
      const enrollments = await prisma.enrollment.findMany({ where: { sectionId: section.id }, select: { id: true } });
      await Promise.all(enrollments.map((e) => recomputeEnrollment(e.id, scale)));
    }
    await audit(req, { action: 'ACTIVITY_UPDATED', entityType: 'Activity', entityId: id, detail: activity.title });
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/activities/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const existing = await prisma.activity.findUnique({ where: { id }, include: { category: { include: { section: { include: { enrollments: true } } } } } });
    if (!existing) return res.status(404).json({ error: 'Activity not found' });
    const section = existing.category.section;
    if (isInstructor(req) && section.instructorId !== req.user.id) return forbid(res);
    if (!isInstructor(req)) return forbid(res);
    if (!sectionEditable(section)) return forbid(res, 'Grades submitted/locked — gradebook is read-only');
    await prisma.activity.delete({ where: { id } });
    const scale = await getActiveScale();
    const enrollments = await prisma.enrollment.findMany({ where: { sectionId: section.id }, select: { id: true } });
    await Promise.all(enrollments.map((e) => recomputeEnrollment(e.id, scale)));
    await audit(req, { action: 'ACTIVITY_DELETED', entityType: 'Activity', entityId: id });
    res.json({ message: 'Activity deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Scores ----
// Validate + upsert a single score, then recompute that enrollment's running grade.
async function upsertScore(req, activity, enrollmentId, rawScore, feedback) {
  let value = null;
  if (rawScore !== '' && rawScore != null) {
    value = parseFloat(rawScore);
    if (isNaN(value) || value < 0) throw new Error('Score must be 0 or greater');
    if (value > activity.maxScore) throw new Error(`Score cannot exceed max (${activity.maxScore})`);
  }
  const score = await prisma.score.upsert({
    where: { activityId_enrollmentId: { activityId: activity.id, enrollmentId } },
    create: {
      activityId: activity.id,
      enrollmentId,
      rawScore: value,
      feedback: feedback ?? null,
      gradedById: req.user.id,
      gradedAt: new Date(),
    },
    update: {
      rawScore: value,
      ...(feedback !== undefined ? { feedback: feedback ?? null } : {}),
      gradedById: req.user.id,
      gradedAt: new Date(),
    },
  });
  return score;
}

router.put('/activities/:activityId/scores/:enrollmentId', async (req, res) => {
  const activityId = parseInt(req.params.activityId);
  const enrollmentId = parseInt(req.params.enrollmentId);
  const { rawScore, feedback } = req.body;
  try {
    const activity = await prisma.activity.findUnique({
      where: { id: activityId },
      include: { category: { include: { section: { include: { enrollments: true } } } } },
    });
    if (!activity) return res.status(404).json({ error: 'Activity not found' });
    const section = activity.category.section;
    if (isInstructor(req) && section.instructorId !== req.user.id) return forbid(res);
    if (!isInstructor(req)) return forbid(res);
    if (!sectionEditable(section)) return forbid(res, 'Grades submitted/locked — gradebook is read-only');

    const score = await upsertScore(req, activity, enrollmentId, rawScore, feedback);
    const updated = await recomputeEnrollment(enrollmentId);
    await audit(req, { action: 'SCORE_UPDATED', entityType: 'Score', entityId: score.id, detail: `activity ${activityId}, enrollment ${enrollmentId}`, newValue: score.rawScore });
    res.json({ score, enrollment: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Bulk entry down a column (one activity, many students).
router.put('/activities/:activityId/scores', async (req, res) => {
  const activityId = parseInt(req.params.activityId);
  const { scores } = req.body; // [{ enrollmentId, rawScore, feedback }]
  if (!Array.isArray(scores)) return res.status(400).json({ error: 'scores array required' });
  try {
    const activity = await prisma.activity.findUnique({
      where: { id: activityId },
      include: { category: { include: { section: { include: { enrollments: true } } } } },
    });
    if (!activity) return res.status(404).json({ error: 'Activity not found' });
    const section = activity.category.section;
    if (isInstructor(req) && section.instructorId !== req.user.id) return forbid(res);
    if (!isInstructor(req)) return forbid(res);
    if (!sectionEditable(section)) return forbid(res, 'Grades submitted/locked — gradebook is read-only');

    const scale = await getActiveScale();
    for (const s of scores) {
      await upsertScore(req, activity, parseInt(s.enrollmentId), s.rawScore, s.feedback);
      await recomputeEnrollment(parseInt(s.enrollmentId), scale);
    }
    await audit(req, { action: 'SCORE_BULK_UPDATED', entityType: 'Activity', entityId: activityId, detail: `${scores.length} scores for activity ${activityId}` });
    res.json({ message: 'Scores saved', count: scores.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ============================================================
 * PROMPT 3 — Transmutation scale, INC, submit
 * ========================================================== */

// ---- Grade scale (transmutation table) ----
router.get('/scale', async (req, res) => {
  try {
    const scale = await getActiveScale();
    res.json(scale);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/scale', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const { rows } = req.body; // [{ minPercent, maxPercent, gradePoint, label }]
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows array required' });
  try {
    for (const r of rows) {
      if (r.minPercent == null || r.maxPercent == null || r.gradePoint == null) {
        return res.status(400).json({ error: 'Each row needs minPercent, maxPercent and gradePoint' });
      }
      if (parseFloat(r.gradePoint) === 4.0) {
        return res.status(400).json({ error: 'There is no 4.00 in this grading model' });
      }
    }
    await prisma.$transaction([
      prisma.gradeScale.deleteMany({}),
      prisma.gradeScale.createMany({
        data: rows.map((r) => ({
          minPercent: parseFloat(r.minPercent),
          maxPercent: parseFloat(r.maxPercent),
          gradePoint: parseFloat(r.gradePoint),
          label: r.label ?? null,
        })),
      }),
    ]);
    await audit(req, { action: 'SCALE_UPDATED', entityType: 'GradeScale', detail: `${rows.length} rows` });
    const scale = await getActiveScale();
    res.json(scale);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- INC mark ----
router.post('/enrollments/:id/inc', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const enrollment = await prisma.enrollment.findUnique({ where: { id }, include: { section: { include: { enrollments: true } } } });
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });
    if (isInstructor(req) && enrollment.section.instructorId !== req.user.id) return forbid(res);
    if (!isInstructor(req)) return forbid(res);
    if (enrollment.gradeStatus === 'LOCKED') return forbid(res, 'Locked — unlock required');
    const updated = await prisma.enrollment.update({ where: { id }, data: { isInc: true, gradePoint: null } });
    await audit(req, { action: 'GRADE_MARKED_INC', entityType: 'Enrollment', entityId: id, newValue: 'INC' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/enrollments/:id/resolve-inc', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const enrollment = await prisma.enrollment.findUnique({ where: { id }, include: { section: true } });
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });
    if (isInstructor(req) && enrollment.section.instructorId !== req.user.id) return forbid(res);
    if (!isInstructor(req)) return forbid(res);
    if (enrollment.gradeStatus === 'LOCKED') return forbid(res, 'Locked — unlock required');
    await prisma.enrollment.update({ where: { id }, data: { isInc: false } });
    const updated = await recomputeEnrollment(id);
    await audit(req, { action: 'GRADE_INC_RESOLVED', entityType: 'Enrollment', entityId: id, newValue: updated?.gradePoint });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Submit final grades for a section ----
router.post('/sections/:id/submit', async (req, res) => {
  const sectionId = parseInt(req.params.id);
  const { section, error } = await loadOwnedSection(req, sectionId);
  if (error) return res.status(error).json({ error: error === 404 ? 'Section not found' : 'Forbidden' });
  if (!isInstructor(req)) return forbid(res, 'Only the section instructor can submit');
  try {
    const categories = await prisma.gradeCategory.findMany({ where: { sectionId } });
    const weightTotal = round2(categories.reduce((s, c) => s + Number(c.weight), 0));
    if (categories.length === 0) return res.status(400).json({ error: 'Add grade categories before submitting' });
    if (weightTotal !== 100) return res.status(400).json({ error: `Category weights must total 100% (currently ${weightTotal}%)` });
    if (section.enrollments.length === 0) return res.status(400).json({ error: 'No students enrolled' });
    if (!sectionEditable(section)) return res.status(409).json({ error: 'Grades already submitted or locked' });

    const scale = await getActiveScale();
    await Promise.all(section.enrollments.map((e) => recomputeEnrollment(e.id, scale)));
    await prisma.enrollment.updateMany({ where: { sectionId }, data: { gradeStatus: 'SUBMITTED' } });
    await audit(req, { action: 'GRADES_SUBMITTED', entityType: 'Section', entityId: sectionId, detail: `${section.enrollments.length} grades submitted` });
    res.json({ message: 'Grades submitted', count: section.enrollments.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
 * PROMPT 4 — Student read-only view
 * ========================================================== */

router.get('/my-grades', async (req, res) => {
  try {
    const scale = await getActiveScale();
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId: req.user.id },
      include: {
        section: {
          include: {
            subject: true,
            semester: true,
            instructor: { select: { fullName: true } },
          },
        },
      },
    });

    // Build the breakdown per enrollment (scores filtered to this student).
    const result = [];
    for (const e of enrollments) {
      // Re-fetch scores scoped to this enrollment for the breakdown.
      const categories = await prisma.gradeCategory.findMany({
        where: { sectionId: e.sectionId },
        orderBy: { createdAt: 'asc' },
        include: { activities: { orderBy: { createdAt: 'asc' }, include: { scores: { where: { enrollmentId: e.id } } } } },
      });
      const { percentage, categoryBreakdown } = computeEnrollmentPercentage(categories, e.id);
      const runningGradePoint = e.isInc ? null : transmute(percentage, scale);
      const finalized = e.gradeStatus !== 'IN_PROGRESS';

      const breakdown = categories.map((cat) => {
        const cb = categoryBreakdown.find((c) => c.categoryId === cat.id);
        return {
          id: cat.id,
          name: cat.name,
          weight: cat.weight,
          percentage: cb?.percentage ?? null,
          activities: cat.activities.map((a) => {
            const sc = a.scores[0];
            return {
              id: a.id,
              title: a.title,
              maxScore: a.maxScore,
              dueDate: a.dueDate,
              rawScore: sc?.rawScore ?? null,
              feedback: sc?.feedback ?? null,
              graded: sc?.rawScore != null,
            };
          }),
        };
      });

      result.push({
        enrollmentId: e.id,
        semester: e.section.semester,
        subject: e.section.subject,
        sectionName: e.section.name,
        instructor: e.section.instructor?.fullName ?? '—',
        gradeStatus: e.gradeStatus,
        finalized,
        isInc: e.isInc,
        displayPercentage: finalized ? e.finalPercentage : percentage,
        displayGradePoint: e.isInc ? null : finalized ? e.gradePoint : runningGradePoint,
        remark: remarkFor({ isInc: e.isInc, gradePoint: finalized ? e.gradePoint : runningGradePoint }),
        breakdown,
      });
    }

    // Group by semester + per-semester GWA.
    const semesters = {};
    for (const r of result) {
      const key = r.semester.id;
      if (!semesters[key]) semesters[key] = { semester: r.semester, subjects: [], gwa: null };
      semesters[key].subjects.push(r);
    }
    for (const key of Object.keys(semesters)) {
      const subs = semesters[key].subjects;
      let weighted = 0;
      let units = 0;
      for (const s of subs) {
        if (!s.isInc && s.displayGradePoint != null) {
          weighted += s.displayGradePoint * Number(s.subject.units);
          units += Number(s.subject.units);
        }
      }
      semesters[key].gwa = units > 0 ? round2(weighted / units) : null;
    }

    res.json(Object.values(semesters).sort((a, b) => b.semester.id - a.semester.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
 * PROMPT 5 — Admin finalize/lock, audit, reports, GWA
 * ========================================================== */

// ---- Lock / unlock ----
router.post('/sections/:id/lock', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const sectionId = parseInt(req.params.id);
  try {
    await prisma.enrollment.updateMany({ where: { sectionId }, data: { gradeStatus: 'LOCKED' } });
    await audit(req, { action: 'SECTION_LOCKED', entityType: 'Section', entityId: sectionId });
    res.json({ message: 'Section locked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sections/:id/unlock', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const sectionId = parseInt(req.params.id);
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'A reason is required to unlock' });
  try {
    await prisma.enrollment.updateMany({ where: { sectionId }, data: { gradeStatus: 'SUBMITTED' } });
    await audit(req, { action: 'SECTION_UNLOCKED', entityType: 'Section', entityId: sectionId, reason: reason.trim() });
    res.json({ message: 'Section unlocked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/semesters/:id/lock', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const semesterId = parseInt(req.params.id);
  try {
    const sections = await prisma.section.findMany({ where: { semesterId }, select: { id: true } });
    const ids = sections.map((s) => s.id);
    await prisma.enrollment.updateMany({ where: { sectionId: { in: ids } }, data: { gradeStatus: 'LOCKED' } });
    await prisma.semester.update({ where: { id: semesterId }, data: { status: 'LOCKED' } });
    await audit(req, { action: 'SEMESTER_LOCKED', entityType: 'Semester', entityId: semesterId, detail: `${ids.length} sections locked` });
    res.json({ message: 'Semester locked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/semesters/:id/unlock', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const semesterId = parseInt(req.params.id);
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'A reason is required to unlock' });
  try {
    const sections = await prisma.section.findMany({ where: { semesterId }, select: { id: true } });
    const ids = sections.map((s) => s.id);
    await prisma.enrollment.updateMany({ where: { sectionId: { in: ids }, gradeStatus: 'LOCKED' }, data: { gradeStatus: 'SUBMITTED' } });
    await prisma.semester.update({ where: { id: semesterId }, data: { status: 'OPEN' } });
    await audit(req, { action: 'SEMESTER_UNLOCKED', entityType: 'Semester', entityId: semesterId, reason: reason.trim() });
    res.json({ message: 'Semester unlocked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Audit log ----
router.get('/audit', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  try {
    const logs = await prisma.gradeAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { actor: { select: { fullName: true, role: true } } },
    });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Reports ----
// Per-section grade sheet.
router.get('/reports/section/:id', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const sectionId = parseInt(req.params.id);
  try {
    const section = await prisma.section.findUnique({
      where: { id: sectionId },
      include: {
        subject: true,
        semester: true,
        instructor: { select: { fullName: true } },
        enrollments: { include: { student: { select: { id: true, fullName: true, email: true } } }, orderBy: { student: { fullName: 'asc' } } },
      },
    });
    if (!section) return res.status(404).json({ error: 'Section not found' });
    const rows = section.enrollments.map((e) => ({
      studentId: e.studentId,
      student: e.student.fullName,
      email: e.student.email,
      percentage: e.finalPercentage,
      gradePoint: e.isInc ? null : e.gradePoint,
      isInc: e.isInc,
      remark: remarkFor({ isInc: e.isInc, gradePoint: e.gradePoint }),
      status: e.gradeStatus,
    }));
    const passed = rows.filter((r) => !r.isInc && r.gradePoint != null && r.gradePoint <= 3.0).length;
    const failed = rows.filter((r) => !r.isInc && r.gradePoint != null && r.gradePoint > 3.0).length;
    const inc = rows.filter((r) => r.isInc).length;
    res.json({ section: { id: section.id, name: section.name, subject: section.subject, semester: section.semester, instructor: section.instructor?.fullName }, rows, summary: { total: rows.length, passed, failed, inc } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-semester summary: pass/fail/INC counts + per-student GWA.
router.get('/reports/semester/:id', async (req, res) => {
  if (!isAdmin(req)) return forbid(res, 'Admin access required');
  const semesterId = parseInt(req.params.id);
  try {
    const semester = await prisma.semester.findUnique({ where: { id: semesterId } });
    if (!semester) return res.status(404).json({ error: 'Semester not found' });
    const enrollments = await prisma.enrollment.findMany({
      where: { section: { semesterId } },
      include: { student: { select: { id: true, fullName: true } }, section: { include: { subject: true } } },
    });

    let passed = 0;
    let failed = 0;
    let inc = 0;
    const byStudent = {};
    for (const e of enrollments) {
      if (e.isInc) inc++;
      else if (e.gradePoint != null && e.gradePoint <= 3.0) passed++;
      else if (e.gradePoint != null && e.gradePoint > 3.0) failed++;

      const sid = e.studentId;
      if (!byStudent[sid]) byStudent[sid] = { studentId: sid, student: e.student.fullName, weighted: 0, units: 0, subjects: 0, inc: 0 };
      byStudent[sid].subjects++;
      if (e.isInc) byStudent[sid].inc++;
      else if (e.gradePoint != null) {
        byStudent[sid].weighted += e.gradePoint * Number(e.section.subject.units);
        byStudent[sid].units += Number(e.section.subject.units);
      }
    }
    const students = Object.values(byStudent).map((s) => ({
      studentId: s.studentId,
      student: s.student,
      subjects: s.subjects,
      inc: s.inc,
      gwa: s.units > 0 ? round2(s.weighted / s.units) : null,
    }));

    res.json({ semester, summary: { total: enrollments.length, passed, failed, inc }, students: students.sort((a, b) => a.student.localeCompare(b.student)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
