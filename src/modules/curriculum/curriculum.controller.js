const curriculumService = require('./curriculum.service');
const { successResponse } = require('../../utils/response');

class CurriculumController {
  // Public Curriculum Endpoint
  async getPublicCurriculum(req, res, next) {
    try {
      const { slug } = req.params;
      console.log(`\n📥 [CURRICULUM READ FLOW] GET /api/courses/${slug}/curriculum`);
      const result = await curriculumService.getPublicCourseCurriculum(slug);
      console.log(` 📖 [CURRICULUM READ FLOW] Returning ${result?.course?.modules?.length || 0} modules for course '${slug}'.`);
      return successResponse(res, result);
    } catch (err) {
      console.error(' ❌ [CURRICULUM GET PUBLIC ERROR]:', err.message || err);
      next(err);
    }
  }

  // Course Versions
  async getVersions(req, res, next) {
    try {
      const { courseId } = req.params;
      console.log(`\n📥 [VERSION READ FLOW] GET /api/courses/${courseId}/versions`);
      const versions = await curriculumService.getVersionsByCourse(courseId);
      return successResponse(res, { versions });
    } catch (err) {
      console.error(' ❌ [VERSION GET ERROR]:', err.message || err);
      next(err);
    }
  }

  async createVersion(req, res, next) {
    try {
      console.log('\n============================================================');
      console.log(' 📌 [VERSION CREATE DATA FLOW] Payload:');
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const version = await curriculumService.createVersion(req.validatedData);
      console.log(' 📌 [VERSION CREATE DATA FLOW] Result:');
      console.log(JSON.stringify(version, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { version }, 201, 'Course version created successfully.');
    } catch (err) {
      console.error(' ❌ [VERSION CREATE ERROR]:', err.message || err);
      next(err);
    }
  }

  async updateVersion(req, res, next) {
    try {
      const { id } = req.params;
      console.log(`\n📌 [VERSION UPDATE DATA FLOW] ID: ${id}`);
      const version = await curriculumService.updateVersion(id, req.validatedData);
      return successResponse(res, { version }, 200, 'Course version updated successfully.');
    } catch (err) {
      console.error(' ❌ [VERSION UPDATE ERROR]:', err.message || err);
      next(err);
    }
  }

  async updateVersionStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { status } = req.body;
      console.log(`\n📌 [VERSION STATUS DATA FLOW] ID: ${id}, Status: ${status}`);
      const version = await curriculumService.updateVersionStatus(id, status);
      return successResponse(res, { version }, 200, 'Course version status updated.');
    } catch (err) {
      console.error(' ❌ [VERSION STATUS ERROR]:', err.message || err);
      next(err);
    }
  }

  // Modules
  async getModules(req, res, next) {
    try {
      const { versionId } = req.params;
      console.log(`\n📥 [MODULE READ FLOW] GET /api/versions/${versionId}/modules`);
      const includeAll = req.query.includeAll === 'true' || req.userRole === 'ADMIN';
      const modules = await curriculumService.getModulesByVersion(versionId, includeAll);
      console.log(` 🧩 [MODULE READ FLOW] Returning ${modules.length} modules.`);
      return successResponse(res, { modules });
    } catch (err) {
      console.error(' ❌ [MODULE GET ERROR]:', err.message || err);
      next(err);
    }
  }

  async createModule(req, res, next) {
    try {
      console.log('\n============================================================');
      console.log(' 🧩 [MODULE CREATE DATA FLOW] Payload Received:');
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const moduleItem = await curriculumService.createModule(req.validatedData);
      console.log(' 🧩 [MODULE CREATE DATA FLOW] Created in DB:');
      console.log(JSON.stringify(moduleItem, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { module: moduleItem }, 201, 'Module created successfully.');
    } catch (err) {
      console.error(' ❌ [MODULE CREATE ERROR]:', err.message || err);
      next(err);
    }
  }

  async getModule(req, res, next) {
    try {
      const { id } = req.params;
      const courseId = req.query.courseId || req.query.course_id;
      console.log(`\n📥 [MODULE READ FLOW] GET /api/modules/${id} (courseId: ${courseId || 'NONE'})`);
      const moduleItem = await curriculumService.getModuleById(id, courseId);
      if (!moduleItem) {
        return res.status(404).json({ status: 'ERROR', message: 'Module not found.' });
      }
      return successResponse(res, { module: moduleItem });
    } catch (err) {
      console.error(' ❌ [MODULE GET BY ID ERROR]:', err.message || err);
      next(err);
    }
  }

  async updateModule(req, res, next) {
    try {
      const { id } = req.params;
      const courseId = req.query.courseId || req.query.course_id || req.body?.courseId || req.body?.course_id || req.validatedData?.course_id;
      console.log('\n============================================================');
      console.log(` 🧩 [MODULE UPDATE DATA FLOW] ID: ${id}, Course ID: ${courseId || 'UNSPECIFIED'}, Payload Received:`);
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const moduleItem = await curriculumService.updateModule(id, req.validatedData || req.body, courseId);
      console.log(' 🧩 [MODULE UPDATE DATA FLOW] Updated in DB:');
      console.log(JSON.stringify(moduleItem, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { module: moduleItem }, 200, 'Module updated successfully.');
    } catch (err) {
      console.error(' ❌ [MODULE UPDATE ERROR]:', err.message || err);
      next(err);
    }
  }

  async updateModuleStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { status } = req.body;
      console.log(`\n🧩 [MODULE STATUS DATA FLOW] ID: ${id}, Status: ${status}`);
      const moduleItem = await curriculumService.updateModuleStatus(id, status);
      return successResponse(res, { module: moduleItem }, 200, 'Module status updated.');
    } catch (err) {
      console.error(' ❌ [MODULE STATUS ERROR]:', err.message || err);
      next(err);
    }
  }

  async reorderModule(req, res, next) {
    try {
      const { id } = req.params;
      const { display_order } = req.validatedData;
      console.log(`\n🧩 [MODULE REORDER DATA FLOW] ID: ${id}, Order: ${display_order}`);
      const moduleItem = await curriculumService.reorderModule(id, display_order);
      return successResponse(res, { module: moduleItem }, 200, 'Module reordered.');
    } catch (err) {
      console.error(' ❌ [MODULE REORDER ERROR]:', err.message || err);
      next(err);
    }
  }

  async deleteModule(req, res, next) {
    try {
      const { id } = req.params;
      const courseId = req.query.courseId || req.query.course_id || req.body?.courseId || req.body?.course_id;
      const force = String(req.query.force || req.body?.force || '').toLowerCase() === 'true'
        || String(req.query.cascade || req.body?.cascade || '').toLowerCase() === 'true';
      console.log('\n============================================================');
      console.log(` 🧩 [MODULE DELETE DATA FLOW] Deleting Module ID: ${id} (Course ID: ${courseId || 'UNSPECIFIED'}, force=${force})`);
      const result = await curriculumService.deleteModule(id, courseId, { force });
      console.log(` 🧩 [MODULE DELETE DATA FLOW] Deleted Module ID: ${id} successfully.`);
      console.log('============================================================\n');
      return successResponse(res, result, 200, 'Module deleted successfully.');
    } catch (err) {
      console.error(' ❌ [MODULE DELETE ERROR]:', err.message || err);
      next(err);
    }
  }

  // Lessons
  async getLessons(req, res, next) {
    try {
      const { moduleId } = req.params;
      console.log(`\n📥 [LESSON READ FLOW] GET /api/modules/${moduleId}/lessons`);
      const includeAll = req.query.includeAll === 'true' || req.userRole === 'ADMIN';
      const lessons = await curriculumService.getLessonsByModule(moduleId, includeAll);
      console.log(` 🎥 [LESSON READ FLOW] Returning ${lessons.length} lessons.`);
      return successResponse(res, { lessons });
    } catch (err) {
      console.error(' ❌ [LESSON GET ERROR]:', err.message || err);
      next(err);
    }
  }

  async createLesson(req, res, next) {
    try {
      console.log('\n============================================================');
      console.log(' 🎥 [LESSON CREATE DATA FLOW] Payload Received:');
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const lesson = await curriculumService.createLesson(req.validatedData);
      console.log(' 🎥 [LESSON CREATE DATA FLOW] Created in DB:');
      console.log(JSON.stringify(lesson, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { lesson }, 201, 'Lesson created successfully.');
    } catch (err) {
      console.error(' ❌ [LESSON CREATE ERROR]:', err.message || err);
      next(err);
    }
  }

  async getLesson(req, res, next) {
    try {
      const { id } = req.params;
      console.log(`\n📥 [LESSON READ FLOW] GET /api/lessons/${id}`);
      const lesson = await curriculumService.getLessonById(id);
      if (!lesson) {
        return res.status(404).json({ status: 'ERROR', message: 'Lesson not found.' });
      }
      return successResponse(res, { lesson });
    } catch (err) {
      console.error(' ❌ [LESSON GET BY ID ERROR]:', err.message || err);
      next(err);
    }
  }

  async updateLesson(req, res, next) {
    try {
      const { id } = req.params;
      console.log('\n============================================================');
      console.log(` 🎥 [LESSON UPDATE DATA FLOW] ID: ${id}, Payload Received:`);
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const lesson = await curriculumService.updateLesson(id, req.validatedData);
      console.log(' 🎥 [LESSON UPDATE DATA FLOW] Updated in DB:');
      console.log(JSON.stringify(lesson, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { lesson }, 200, 'Lesson updated successfully.');
    } catch (err) {
      console.error(' ❌ [LESSON UPDATE ERROR]:', err.message || err);
      next(err);
    }
  }

  async updateLessonStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { status } = req.body;
      console.log(`\n🎥 [LESSON STATUS DATA FLOW] ID: ${id}, Status: ${status}`);
      const lesson = await curriculumService.updateLessonStatus(id, status);
      return successResponse(res, { lesson }, 200, 'Lesson status updated.');
    } catch (err) {
      console.error(' ❌ [LESSON STATUS ERROR]:', err.message || err);
      next(err);
    }
  }

  async reorderLesson(req, res, next) {
    try {
      const { id } = req.params;
      const { display_order } = req.validatedData;
      console.log(`\n🎥 [LESSON REORDER DATA FLOW] ID: ${id}, Order: ${display_order}`);
      const lesson = await curriculumService.reorderLesson(id, display_order);
      return successResponse(res, { lesson }, 200, 'Lesson reordered.');
    } catch (err) {
      console.error(' ❌ [LESSON REORDER ERROR]:', err.message || err);
      next(err);
    }
  }

  async deleteLesson(req, res, next) {
    try {
      const { id } = req.params;
      console.log('\n============================================================');
      console.log(` 🎥 [LESSON DELETE DATA FLOW] Deleting Lesson ID: ${id}`);
      await curriculumService.deleteLesson(id);
      console.log(` 🎥 [LESSON DELETE DATA FLOW] Deleted Lesson ID: ${id} successfully.`);
      console.log('============================================================\n');
      return successResponse(res, null, 200, 'Lesson deleted successfully.');
    } catch (err) {
      console.error(' ❌ [LESSON DELETE ERROR]:', err.message || err);
      next(err);
    }
  }

  // Topics
  async getTopics(req, res, next) {
    try {
      const { lessonId } = req.params;
      console.log(`\n📥 [TOPIC READ FLOW] GET /api/lessons/${lessonId}/topics`);
      const topics = await curriculumService.getTopicsByLesson(lessonId);
      console.log(` 🏷️ [TOPIC READ FLOW] Returning ${topics.length} topics.`);
      return successResponse(res, { topics });
    } catch (err) {
      console.error(' ❌ [TOPIC GET ERROR]:', err.message || err);
      next(err);
    }
  }

  async createTopic(req, res, next) {
    try {
      console.log('\n============================================================');
      console.log(' 🏷️ [TOPIC CREATE DATA FLOW] Payload Received:');
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const topic = await curriculumService.createTopic(req.validatedData);
      console.log(' 🏷️ [TOPIC CREATE DATA FLOW] Created in DB:');
      console.log(JSON.stringify(topic, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { topic }, 201, 'Topic created successfully.');
    } catch (err) {
      console.error(' ❌ [TOPIC CREATE ERROR]:', err.message || err);
      next(err);
    }
  }

  async updateTopic(req, res, next) {
    try {
      const { id } = req.params;
      console.log('\n============================================================');
      console.log(` 🏷️ [TOPIC UPDATE DATA FLOW] ID: ${id}, Payload Received:`);
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const topic = await curriculumService.updateTopic(id, req.validatedData);
      console.log(' 🏷️ [TOPIC UPDATE DATA FLOW] Updated in DB:');
      console.log(JSON.stringify(topic, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { topic }, 200, 'Topic updated successfully.');
    } catch (err) {
      console.error(' ❌ [TOPIC UPDATE ERROR]:', err.message || err);
      next(err);
    }
  }

  async reorderTopic(req, res, next) {
    try {
      const { id } = req.params;
      const { display_order } = req.validatedData;
      console.log(`\n🏷️ [TOPIC REORDER DATA FLOW] ID: ${id}, Order: ${display_order}`);
      const topic = await curriculumService.reorderTopic(id, display_order);
      return successResponse(res, { topic }, 200, 'Topic reordered.');
    } catch (err) {
      console.error(' ❌ [TOPIC REORDER ERROR]:', err.message || err);
      next(err);
    }
  }

  async deleteTopic(req, res, next) {
    try {
      const { id } = req.params;
      console.log('\n============================================================');
      console.log(` 🏷️ [TOPIC DELETE DATA FLOW] Deleting Topic ID: ${id}`);
      await curriculumService.deleteTopic(id);
      console.log(` 🏷️ [TOPIC DELETE DATA FLOW] Deleted Topic ID: ${id} successfully.`);
      console.log('============================================================\n');
      return successResponse(res, null, 200, 'Topic deleted successfully.');
    } catch (err) {
      console.error(' ❌ [TOPIC DELETE ERROR]:', err.message || err);
      next(err);
    }
  }
}

module.exports = new CurriculumController();
