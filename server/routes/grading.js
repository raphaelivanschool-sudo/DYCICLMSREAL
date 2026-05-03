import express from 'express';
import { PrismaClient } from '@prisma/client';
import { processGrade } from '../utils/gradeComputer.js';
import { recordActivity, clientIp, summarizePayload } from '../utils/activityLog.js';

const router = express.Router();
const prisma = new PrismaClient();

function isInstructorOrAdmin(role) {
  const r = role?.toLowerCase();
  return r === 'instructor' || r === 'admin';
}

// GET /api/grading/subjects
router.get('/subjects', async (req, res) => {
  try {
    const where = req.user.role?.toLowerCase() === 'admin'
      ? { status: 'ACTIVE' }
      : { instructorId: req.user.id, status: 'ACTIVE' };

    const subjects = await prisma.subject.findMany({
      where,
      include: {
        instructor: { select: { id: true, fullName: true } },
        _count:      { select: { grades: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(subjects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/grading/subjects
router.post('/subjects', async (req, res) => {
  console.log('POST /subjects - req.user:', req.user);
  console.log('POST /subjects - req.user.role:', req.user?.role);
  console.log('POST /subjects - isInstructorOrAdmin:', isInstructorOrAdmin(req.user?.role));
  
  if (!isInstructorOrAdmin(req.user?.role)) {
    console.log('POST /subjects - FORBIDDEN: role is', req.user?.role);
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { name, code, yearSection } = req.body;
  if (!name || !code || !yearSection) {
    return res.status(400).json({ error: 'name, code, and yearSection are required' });
  }
  try {
    const instructorId = req.user.role?.toLowerCase() === 'admin' && req.body.instructorId
      ? req.body.instructorId
      : req.user.id;

    // Check for duplicate subject code for same instructor and yearSection
    const existingSubject = await prisma.subject.findFirst({
      where: {
        code,
        instructorId,
        yearSection,
        status: 'ACTIVE',
      },
    });
    if (existingSubject) {
      return res.status(409).json({ error: 'A subject with this code already exists for this year section' });
    }

    const subject = await prisma.subject.create({
      data: {
        name,
        code,
        yearSection,
        instructorId,
      },
      include: {
        instructor: { select: { id: true, fullName: true } },
      },
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'GRADING_SUBJECT_CREATED',
      description: `Subject "${subject.code}" ${subject.name} (${subject.yearSection}) id=${subject.id}`,
      ipAddress: clientIp(req),
    });

    res.status(201).json(subject);
  } catch (err) {
    console.error('Error creating subject:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/grading/subjects/:id  (soft delete — sets status to INACTIVE)
router.delete('/subjects/:id', async (req, res) => {
  if (!isInstructorOrAdmin(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const subject = await prisma.subject.findUnique({
      where: { id: parseInt(req.params.id) },
    });
    if (!subject) return res.status(404).json({ error: 'Subject not found' });
    if (req.user.role?.toLowerCase() === 'instructor' && subject.instructorId !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own subjects' });
    }
    await prisma.subject.update({
      where: { id: parseInt(req.params.id) },
      data:  { status: 'INACTIVE' },
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'GRADING_SUBJECT_DELETED',
      description: `Subject id=${req.params.id} "${subject.code}" soft-deleted (inactive)`,
      ipAddress: clientIp(req),
    });

    res.json({ message: 'Subject removed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/grading/subjects/:subjectId/grades
router.get('/subjects/:subjectId/grades', async (req, res) => {
  try {
    const subjectId = parseInt(req.params.subjectId);
    const subject   = await prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject) return res.status(404).json({ error: 'Subject not found' });

    if (req.user.role?.toLowerCase() === 'instructor' && subject.instructorId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const students = await prisma.user.findMany({
      where: {
        role: 'student',
        yearSection: subject.yearSection,
      },
      select: { id: true, fullName: true, email: true },
    });

    try {
      const grades = await Promise.all(
        students.map((student) =>
          prisma.grade.upsert({
            where:  { subjectId_studentId: { subjectId, studentId: student.id } },
            create: { subjectId, studentId: student.id },
            update: {},
            include: { student: { select: { id: true, fullName: true, email: true } } },
          })
        )
      );
      res.json(grades);
    } catch (upsertErr) {
      console.error('Grade upsert error:', upsertErr);
      return res.status(500).json({ error: 'Failed to load student grades' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/grading/grades/:gradeId
// Body: { prelim, midterm, semiFinals, finals, remarks }
// remarks is only used for manual overrides (DROPPED). All other remarks are auto-computed.
router.put('/grades/:gradeId', async (req, res) => {
  if (!isInstructorOrAdmin(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const gradeId  = parseInt(req.params.gradeId);
    const existing = await prisma.grade.findUnique({
      where:   { id: gradeId },
      include: { subject: true },
    });
    if (!existing) return res.status(404).json({ error: 'Grade not found' });
    if (req.user.role?.toLowerCase() === 'instructor' && existing.subject.instructorId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Validate input scores are between 0 and 100
    const validateScore = (score, fieldName) => {
      if (score == null) return null;
      const num = parseFloat(score);
      if (isNaN(num) || num < 0 || num > 100) {
        throw new Error(`${fieldName} must be between 0 and 100`);
      }
      return num;
    };

    let prelim, midterm, semiFinals, finals;
    try {
      prelim     = req.body.prelim     != null ? validateScore(req.body.prelim, 'prelim')     : existing.prelim;
      midterm    = req.body.midterm    != null ? validateScore(req.body.midterm, 'midterm')    : existing.midterm;
      semiFinals = req.body.semiFinals != null ? validateScore(req.body.semiFinals, 'semiFinals') : existing.semiFinals;
      finals     = req.body.finals     != null ? validateScore(req.body.finals, 'finals')     : existing.finals;
    } catch (validationErr) {
      return res.status(400).json({ error: validationErr.message });
    }

    const manualRemarks = req.body.remarks === 'DROPPED' ? 'DROPPED' : null;

    const { transmutedGrade, remarks: autoRemarks } = processGrade(
      prelim, midterm, semiFinals, finals
    );

    const updated = await prisma.grade.update({
      where: { id: gradeId },
      data: {
        prelim,
        midterm,
        semiFinals,
        finals,
        transmutedGrade,
        remarks: manualRemarks ?? autoRemarks,
      },
      include: { student: { select: { id: true, fullName: true, email: true } } },
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'GRADING_GRADE_UPDATED',
      description: `Grade id=${gradeId} student=${updated.student?.fullName || ''} subject=${existing.subject?.code || ''} ${summarizePayload({ prelim, midterm, semiFinals, finals })}`,
      ipAddress: clientIp(req),
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/grading/my-grades  (students view their own grades)
router.get('/my-grades', async (req, res) => {
  try {
    const grades = await prisma.grade.findMany({
      where:   { studentId: req.user.id },
      include: {
        subject: {
          select: {
            name: true, code: true, yearSection: true,
            instructor: { select: { fullName: true } },
          },
        },
      },
      orderBy: { subject: { yearSection: 'asc' } },
    });
    res.json(grades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/grading/subjects/:subjectId/enroll
// Enroll a student in a subject (admin only)
router.post('/subjects/:subjectId/enroll', async (req, res) => {
  if (req.user.role?.toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const subjectId = parseInt(req.params.subjectId);
  const { studentId } = req.body;

  if (!studentId) {
    return res.status(400).json({ error: 'studentId is required' });
  }

  try {
    // Verify subject exists
    const subject = await prisma.subject.findUnique({
      where: { id: subjectId },
    });
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    // Verify student exists and is a student
    const student = await prisma.user.findFirst({
      where: { id: parseInt(studentId), role: 'STUDENT' },
      select: { id: true, fullName: true, yearSection: true },
    });
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Create grade record (enrollment)
    const grade = await prisma.grade.upsert({
      where: { subjectId_studentId: { subjectId, studentId: student.id } },
      create: { subjectId, studentId: student.id },
      update: {},
      include: { student: { select: { id: true, fullName: true, email: true } } },
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'GRADING_STUDENT_ENROLLED',
      description: `Enrolled ${student.fullName} in subject ${subject.code} (${subjectId})`,
      ipAddress: clientIp(req),
    });

    res.status(201).json({ message: 'Student enrolled successfully', grade });
  } catch (err) {
    console.error('Enrollment error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/grading/students
// Search students by name or email (admin only)
router.get('/students', async (req, res) => {
  if (req.user.role?.toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { search, yearSection } = req.query;

  try {
    const where = {
      role: 'STUDENT',
      ...(search && {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }),
      ...(yearSection && { yearSection }),
    };

    const students = await prisma.user.findMany({
      where,
      select: { id: true, fullName: true, email: true, yearSection: true },
      take: 20,
      orderBy: { fullName: 'asc' },
    });

    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
