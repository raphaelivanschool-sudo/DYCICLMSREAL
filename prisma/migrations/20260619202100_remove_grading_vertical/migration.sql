-- DropForeignKey
ALTER TABLE `activity` DROP FOREIGN KEY `Activity_categoryId_fkey`;

-- DropForeignKey
ALTER TABLE `enrollment` DROP FOREIGN KEY `Enrollment_sectionId_fkey`;

-- DropForeignKey
ALTER TABLE `enrollment` DROP FOREIGN KEY `Enrollment_studentId_fkey`;

-- DropForeignKey
ALTER TABLE `gradeauditlog` DROP FOREIGN KEY `GradeAuditLog_actorId_fkey`;

-- DropForeignKey
ALTER TABLE `gradecategory` DROP FOREIGN KEY `GradeCategory_sectionId_fkey`;

-- DropForeignKey
ALTER TABLE `score` DROP FOREIGN KEY `Score_activityId_fkey`;

-- DropForeignKey
ALTER TABLE `score` DROP FOREIGN KEY `Score_enrollmentId_fkey`;

-- DropForeignKey
ALTER TABLE `score` DROP FOREIGN KEY `Score_gradedById_fkey`;

-- DropForeignKey
ALTER TABLE `section` DROP FOREIGN KEY `Section_instructorId_fkey`;

-- DropForeignKey
ALTER TABLE `section` DROP FOREIGN KEY `Section_labScheduleId_fkey`;

-- DropForeignKey
ALTER TABLE `section` DROP FOREIGN KEY `Section_semesterId_fkey`;

-- DropForeignKey
ALTER TABLE `section` DROP FOREIGN KEY `Section_subjectId_fkey`;

-- DropTable
DROP TABLE `activity`;

-- DropTable
DROP TABLE `enrollment`;

-- DropTable
DROP TABLE `gradeauditlog`;

-- DropTable
DROP TABLE `gradecategory`;

-- DropTable
DROP TABLE `gradescale`;

-- DropTable
DROP TABLE `score`;

-- DropTable
DROP TABLE `section`;

-- DropTable
DROP TABLE `semester`;

-- DropTable
DROP TABLE `subject`;

