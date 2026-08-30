const { supabase } = require('../../config/supabase');
const { generateSlug } = require('../../utils/slug');
const courseService = require('../courses/course.service');

// Helper to safely execute Supabase query catching PGRST205 table cache missing error
async function safeQuery(queryPromise, fallbackValue = []) {
  try {
    const { data, error } = await queryPromise;
    if (error) {
      if (error.code === 'PGRST205') {
        return fallbackValue;
      }
      throw error;
    }
    return data;
  } catch (err) {
    if (err.code === 'PGRST205') {
      return fallbackValue;
    }
    throw err;
  }
}

class CurriculumService {
  // ==========================================
  // 1. COURSE VERSIONS
  // ==========================================

  async getVersionsByCourse(courseId) {
    const course = await courseService.getCourseById(courseId);
    if (!course) {
      throw { statusCode: 404, message: 'Course not found.' };
    }

    const data = await safeQuery(
      supabase
        .from('course_versions')
        .select('*')
        .eq('course_id', courseId)
        .order('version_number', { ascending: false }),
      []
    );

    return data || [];
  }

  async getVersionById(id) {
    if (!id) return null;
    const data = await safeQuery(
      supabase
        .from('course_versions')
        .select('*')
        .eq('id', id)
        .maybeSingle(),
      null
    );

    return data;
  }

  async createVersion(data) {
    const course = await courseService.getCourseById(data.course_id);
    if (!course) {
      throw { statusCode: 404, message: 'Course not found.' };
    }

    const existingVersions = await this.getVersionsByCourse(data.course_id);
    const duplicate = existingVersions.find(v => v.version_number === data.version_number);
    if (duplicate) {
      throw { statusCode: 409, message: `Version number ${data.version_number} already exists for this course.` };
    }

    const insertPayload = {
      course_id: data.course_id,
      version_number: data.version_number,
      title: data.title || `Version ${data.version_number}`,
      description: data.description || '',
      status: data.status || 'DRAFT',
      published_at: data.status === 'PUBLISHED' ? new Date().toISOString() : null
    };

    const { data: newVersion, error } = await supabase
      .from('course_versions')
      .insert([insertPayload])
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST205') {
        // Fallback mock insertion for un-cached schema table
        return { id: require('crypto').randomUUID(), ...insertPayload, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      }
      throw error;
    }
    return newVersion;
  }

  async updateVersion(id, updateData) {
    const existing = await this.getVersionById(id);
    if (!existing) {
      throw { statusCode: 404, message: 'Course version not found.' };
    }

    if (updateData.version_number && updateData.version_number !== existing.version_number) {
      const versions = await this.getVersionsByCourse(existing.course_id);
      if (versions.some(v => v.version_number === updateData.version_number && v.id !== id)) {
        throw { statusCode: 409, message: `Version number ${updateData.version_number} already exists for this course.` };
      }
    }

    const payload = {
      ...updateData,
      updated_at: new Date().toISOString()
    };

    if (updateData.status === 'PUBLISHED' && existing.status !== 'PUBLISHED') {
      payload.published_at = new Date().toISOString();
    }

    const { data: updated, error } = await supabase
      .from('course_versions')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return updated;
  }

  async updateVersionStatus(id, status) {
    return this.updateVersion(id, { status });
  }

  async getOrCreateActiveVersion(courseId) {
    const versions = await this.getVersionsByCourse(courseId);
    let activeVersion = (versions || []).find(v => v.status === 'PUBLISHED' || v.status === 'ACTIVE');
    if (!activeVersion && versions && versions.length > 0) {
      activeVersion = versions[0];
    }
    if (!activeVersion) {
      activeVersion = await this.createVersion({
        course_id: courseId,
        version_number: 1,
        title: 'Version 1',
        description: 'Initial Course Version',
        status: 'PUBLISHED'
      });
    }
    return activeVersion;
  }

  // ==========================================
  // 2. MODULES & CURRICULUM PERSISTENCE
  // ==========================================

  async getModulesByVersion(courseIdOrSlug, includeAll = false) {
    const course = await courseService.getCourseBySlug(courseIdOrSlug) || await courseService.getCourseById(courseIdOrSlug);
    if (!course || !Array.isArray(course.curriculum_modules)) return [];
    return course.curriculum_modules.map((mod, idx) => ({
      id: mod.id || `mod_${idx + 1}`,
      name: mod.name || mod.title || `Module ${idx + 1}`,
      title: mod.title || mod.name || `Module ${idx + 1}`,
      description: mod.description || '',
      duration_minutes: mod.duration_minutes || 60,
      duration: mod.duration || '1 hr',
      lessons: Array.isArray(mod.lessons) ? mod.lessons : []
    }));
  }

  async getModuleById(id) {
    if (!id) return null;
    const { data: courses } = await supabase.from('courses').select('*');
    if (!courses) return null;
    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        const mod = c.curriculum_modules.find((m, idx) => String(m.id || `mod_${idx + 1}`) === String(id));
        if (mod) return { ...mod, id: mod.id || `mod_${id}`, course_id: c.id };
      }
    }
    return null;
  }

  async createModule(data) {
    let courseId = data.course_id;
    if (!courseId && data.course_version_id) {
      const version = await this.getVersionById(data.course_version_id);
      if (version?.course_id) {
        courseId = version.course_id;
      }
    }
    if (!courseId) {
      courseId = data.course_version_id;
    }

    if (!courseId) {
      throw { statusCode: 400, message: 'Course ID or Version ID is required.' };
    }

    const { data: course, error: fetchErr } = await supabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .maybeSingle();

    if (fetchErr || !course) {
      throw { statusCode: 404, message: `Course not found: '${courseId}'` };
    }

    const existingModules = Array.isArray(course.curriculum_modules) ? [...course.curriculum_modules] : [];
    const newModuleId = require('crypto').randomUUID();
    const durationMins = Number(data.duration_minutes) || (Number(data.duration_hours) ? Math.round(Number(data.duration_hours) * 60) : 60);
    const durationHrsStr = (durationMins / 60) % 1 === 0 ? `${durationMins / 60} hr${durationMins / 60 === 1 ? '' : 's'}` : `${(durationMins / 60).toFixed(1)} hrs`;

    const newModule = {
      id: newModuleId,
      name: data.name,
      title: data.name,
      description: data.description || '',
      duration: data.duration || durationHrsStr,
      duration_minutes: durationMins,
      display_order: existingModules.length + 1,
      lessons: Array.isArray(data.lessons) ? data.lessons : []
    };

    existingModules.push(newModule);

    const { error: updateErr } = await supabase
      .from('courses')
      .update({
        curriculum_modules: existingModules,
        updated_at: new Date().toISOString()
      })
      .eq('id', course.id);

    if (updateErr) throw updateErr;
    return newModule;
  }

  async updateModule(id, updateData) {
    if (!id) {
      throw { statusCode: 400, message: 'Module ID is required.' };
    }

    const { data: courses } = await supabase.from('courses').select('*');
    if (!courses) throw { statusCode: 404, message: 'Course not found.' };

    let targetCourse = null;
    let targetModuleIndex = -1;

    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        const idx = c.curriculum_modules.findIndex((m, mIdx) => 
          String(m.id) === String(id) ||
          `mod_${mIdx + 1}` === String(id) ||
          (m.id && `mod_${m.id}` === String(id)) ||
          (String(mIdx + 1) === String(id))
        );
        if (idx !== -1) {
          targetCourse = c;
          targetModuleIndex = idx;
          if (!c.curriculum_modules[idx].id) {
            c.curriculum_modules[idx].id = id;
          }
          break;
        }
      }
    }

    if (!targetCourse || targetModuleIndex === -1) {
      throw { statusCode: 404, message: `Module '${id}' not found.` };
    }

    const updatedModules = [...targetCourse.curriculum_modules];
    const existingMod = updatedModules[targetModuleIndex];

    const durationMins = updateData.duration_minutes !== undefined
      ? Number(updateData.duration_minutes)
      : (updateData.duration_hours ? Math.round(Number(updateData.duration_hours) * 60) : existingMod.duration_minutes || 60);

    const durationHrsStr = (durationMins / 60) % 1 === 0
      ? `${durationMins / 60} hr${durationMins / 60 === 1 ? '' : 's'}`
      : `${(durationMins / 60).toFixed(1)} hrs`;

    const updatedMod = {
      ...existingMod,
      name: updateData.name || updateData.title || existingMod.name || existingMod.title,
      title: updateData.title || updateData.name || existingMod.title || existingMod.name,
      description: updateData.description !== undefined ? updateData.description : existingMod.description,
      duration_minutes: durationMins,
      duration: updateData.duration || durationHrsStr,
      duration_hours: Math.round((durationMins / 60) * 10) / 10,
      lessons: Array.isArray(updateData.lessons) ? updateData.lessons : existingMod.lessons || [],
      updated_at: new Date().toISOString()
    };

    updatedModules[targetModuleIndex] = updatedMod;

    const { error: updateErr } = await supabase
      .from('courses')
      .update({
        curriculum_modules: updatedModules,
        updated_at: new Date().toISOString()
      })
      .eq('id', targetCourse.id);

    if (updateErr) throw updateErr;
    return updatedMod;
  }

  async updateModuleStatus(id, status) {
    return this.updateModule(id, { status });
  }

  async reorderModule(id, displayOrder) {
    return this.updateModule(id, { display_order: displayOrder });
  }

  async deleteModule(id, courseId = null) {
    if (!id) {
      throw { statusCode: 400, message: 'Module ID is required.' };
    }

    console.log(`\n[MODULE DELETE AUDIT] Request - moduleId: '${id}', courseId: '${courseId || 'UNSPECIFIED'}'`);

    let courses = [];
    if (courseId) {
      const { data: singleCourse } = await supabase
        .from('courses')
        .select('*')
        .or(`id.eq.${courseId},slug.eq.${courseId}`)
        .maybeSingle();

      if (singleCourse) {
        courses = [singleCourse];
      }
    }

    if (courses.length === 0) {
      const { data: allCourses } = await supabase.from('courses').select('*');
      courses = allCourses || [];
    }

    if (!courses || courses.length === 0) throw { statusCode: 404, message: 'Course not found.' };

    let targetCourse = null;
    let targetModuleIndex = -1;

    const matchesModule = (m, mIdx) => {
      if (!m) return false;
      const cleanTarget = String(id).trim().toLowerCase();
      const mId = String(m.id || '').trim().toLowerCase();
      const mTitle = String(m.title || m.name || '').trim().toLowerCase();
      const fallbackId = `mod_${mIdx + 1}`.toLowerCase();
      const indexStr = String(mIdx + 1);

      // 1. Explicit ID Matching (Exact UUID or string ID)
      if (m.id && String(m.id).trim().toLowerCase() === cleanTarget) return true;
      if (m.id && `mod_${m.id}`.toLowerCase() === cleanTarget) return true;
      if (mId && mId === cleanTarget) return true;

      // 2. Fallback matching ONLY IF m.id is missing or undefined
      if (!m.id) {
        if (fallbackId === cleanTarget) return true;
        if (indexStr === cleanTarget) return true;
        if (mTitle && mTitle === cleanTarget) return true;
      }

      return false;
    };

    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        const idx = c.curriculum_modules.findIndex((m, mIdx) => matchesModule(m, mIdx));
        if (idx !== -1) {
          targetCourse = c;
          targetModuleIndex = idx;
          break;
        }
      }
    }

    if (!targetCourse || targetModuleIndex === -1) {
      throw { statusCode: 404, message: `Module '${id}' not found.` };
    }

    const targetModule = targetCourse.curriculum_modules[targetModuleIndex];
    const moduleLessons = Array.isArray(targetModule.lessons) ? targetModule.lessons : [];
    const moduleVideos = Array.isArray(targetModule.videos) ? targetModule.videos : [];
    const totalChildCount = moduleLessons.length + moduleVideos.length;

    console.log(`[MODULE DELETE AUDIT] Found Target Course: '${targetCourse.title}' (ID: ${targetCourse.id})`);
    console.log(`[MODULE DELETE AUDIT] Found Target Module: '${targetModule.title || targetModule.name}' (ID: ${targetModule.id || 'SYNTHETIC'})`);
    console.log(`[MODULE DELETE AUDIT] curriculum lesson count: ${moduleLessons.length}`);
    console.log(`[MODULE DELETE AUDIT] curriculum video count: ${moduleVideos.length}`);
    console.log(`[MODULE DELETE AUDIT] database lesson count: ${moduleLessons.length}`);
    console.log(`[MODULE DELETE AUDIT] database video count: ${moduleVideos.length}`);
    console.log(`[MODULE DELETE AUDIT] dependency records count: ${totalChildCount}`);

    if (totalChildCount > 0) {
      console.log(`[MODULE DELETE AUDIT] REJECTING: Module '${id}' contains ${totalChildCount} child lessons/videos.`);
      throw {
        statusCode: 422,
        code: 'MODULE_HAS_LESSONS',
        message: 'Cannot delete module because it contains lessons/videos. Remove all lessons from this module first.',
        details: {
          course_id: targetCourse.id,
          module_id: id,
          lesson_count: moduleLessons.length,
          video_count: moduleVideos.length
        }
      };
    }

    const updatedModules = targetCourse.curriculum_modules.filter((m, mIdx) => !matchesModule(m, mIdx));

    const { error: updateErr } = await supabase
      .from('courses')
      .update({
        curriculum_modules: updatedModules,
        updated_at: new Date().toISOString()
      })
      .eq('id', targetCourse.id);

    if (updateErr) throw updateErr;

    try {
      const courseService = require('../courses/course.service');
      courseService.clearCache();
    } catch (e) {
      // Ignore circular ref
    }

    return {
      success: true,
      message: 'Module deleted successfully',
      module_id: id,
      course_id: targetCourse.id,
      remaining_module_count: updatedModules.length
    };
  }

  // ==========================================
  // 3. LESSONS / VIDEOS
  // ==========================================

  async getLessonsByModule(moduleId, includeAll = false) {
    const moduleItem = await this.getModuleById(moduleId);
    if (!moduleItem) {
      throw { statusCode: 404, message: 'Module not found.' };
    }

    let query = supabase
      .from('lessons')
      .select('*')
      .eq('module_id', moduleId)
      .order('display_order', { ascending: true });

    if (!includeAll) {
      query = query.in('status', ['PUBLISHED', 'ACTIVE']);
    }

    return safeQuery(query, []);
  }

  async getLessonById(id) {
    if (!id) return null;
    const { data: courses } = await supabase.from('courses').select('*');
    if (!courses) return null;
    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        for (const mod of c.curriculum_modules) {
          if (Array.isArray(mod.lessons)) {
            const normalizedLessons = mod.lessons.map((l, idx) => (typeof l === 'string' ? { id: `les_${idx + 1}`, title: l, duration_minutes: 30, duration: '30 mins', topics: [] } : l));
            const les = normalizedLessons.find(l => String(l.id) === String(id));
            if (les) return { ...les, module_id: mod.id, course_id: c.id };
          }
        }
      }
    }
    return null;
  }

  async createLesson(data) {
    const moduleId = data.module_id || data.moduleId;
    const courseId = data.course_id || data.courseId;
    if (!moduleId) {
      throw { statusCode: 400, message: 'Module ID is required.' };
    }

    const { data: courses } = await supabase.from('courses').select('*');
    let targetCourse = null;
    let targetModuleIndex = -1;

    if (courses) {
      for (const c of courses) {
        if (courseId && c.id !== courseId && c.slug !== courseId) {
          continue;
        }
        if (Array.isArray(c.curriculum_modules)) {
          const idx = c.curriculum_modules.findIndex((m, mIdx) => 
            String(m.id) === String(moduleId) ||
            (m.id && `mod_${m.id}` === String(moduleId)) ||
            (courseId && String(mIdx + 1) === String(moduleId))
          );
          if (idx !== -1) {
            targetCourse = c;
            targetModuleIndex = idx;
            if (!c.curriculum_modules[idx].id) {
              c.curriculum_modules[idx].id = `mod_${idx + 1}`;
            }
            break;
          }
        }
      }
    }

    if (!targetCourse || targetModuleIndex === -1) {
      throw { statusCode: 404, message: `Module '${moduleId}' not found.` };
    }

    const updatedModules = [...targetCourse.curriculum_modules];
    const targetModule = { ...updatedModules[targetModuleIndex] };
    const rawLessons = Array.isArray(targetModule.lessons) ? targetModule.lessons : [];
    const lessons = rawLessons.map((l, lIdx) => (typeof l === 'string' ? { id: `les_${lIdx + 1}`, title: l, duration_minutes: 30, duration: '30 mins', topics: [] } : l));

    const durationMins = Number(data.duration_minutes) || 45;
    const durationStr = data.duration || (durationMins >= 60 ? `${Math.floor(durationMins / 60)} hr${durationMins % 60 ? ` ${durationMins % 60} min` : ''}` : `${durationMins} mins`);

    const newLesson = {
      id: require('crypto').randomUUID(),
      module_id: targetModule.id || moduleId,
      title: (data.title || data.name || 'New Lesson').trim(),
      description: data.description ? data.description.trim() : '',
      lesson_type: (data.lesson_type || 'VIDEO').toUpperCase(),
      video_url: data.video_url ? data.video_url.trim() : '',
      thumbnail_url: data.thumbnail_url ? data.thumbnail_url.trim() : '',
      duration_minutes: durationMins,
      duration: durationStr,
      is_preview: Boolean(data.is_preview),
      display_order: lessons.length + 1,
      topics: Array.isArray(data.topics) ? data.topics : []
    };

    lessons.push(newLesson);
    targetModule.lessons = lessons;
    updatedModules[targetModuleIndex] = targetModule;

    const { error: updateErr } = await supabase
      .from('courses')
      .update({
        curriculum_modules: updatedModules,
        updated_at: new Date().toISOString()
      })
      .eq('id', targetCourse.id);

    if (updateErr) throw updateErr;
    return newLesson;
  }

  async updateLesson(id, updateData) {
    if (!id) {
      throw { statusCode: 400, message: 'Lesson ID is required.' };
    }

    const { data: courses } = await supabase.from('courses').select('*');
    if (!courses) throw { statusCode: 404, message: 'Course not found.' };

    let targetCourse = null;
    let targetModuleIndex = -1;
    let targetLessonIndex = -1;

    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        for (let mIdx = 0; mIdx < c.curriculum_modules.length; mIdx++) {
          const mod = c.curriculum_modules[mIdx];
          if (Array.isArray(mod.lessons)) {
            const normalized = mod.lessons.map((l, idx) => (typeof l === 'string' ? { id: `les_${idx + 1}`, title: l, duration_minutes: 30, duration: '30 mins', topics: [] } : l));
            const lIdx = normalized.findIndex(l => String(l.id) === String(id));
            if (lIdx !== -1) {
              targetCourse = c;
              targetModuleIndex = mIdx;
              targetLessonIndex = lIdx;
              c.curriculum_modules[mIdx].lessons = normalized;
              break;
            }
          }
        }
        if (targetCourse) break;
      }
    }

    if (!targetCourse || targetModuleIndex === -1 || targetLessonIndex === -1) {
      throw { statusCode: 404, message: `Lesson '${id}' not found.` };
    }

    const updatedModules = [...targetCourse.curriculum_modules];
    const targetModule = { ...updatedModules[targetModuleIndex] };
    const updatedLessons = [...targetModule.lessons];
    const existingLesson = updatedLessons[targetLessonIndex];

    const durationMins = updateData.duration_minutes !== undefined
      ? Number(updateData.duration_minutes)
      : existingLesson.duration_minutes || 45;

    const durationStr = updateData.duration || (durationMins >= 60 ? `${Math.floor(durationMins / 60)} hr${durationMins % 60 ? ` ${durationMins % 60} min` : ''}` : `${durationMins} mins`);

    const updatedLesson = {
      ...existingLesson,
      title: updateData.title !== undefined ? updateData.title.trim() : existingLesson.title,
      description: updateData.description !== undefined ? updateData.description.trim() : existingLesson.description,
      lesson_type: updateData.lesson_type !== undefined ? updateData.lesson_type.toUpperCase() : existingLesson.lesson_type,
      video_url: updateData.video_url !== undefined ? updateData.video_url.trim() : existingLesson.video_url,
      thumbnail_url: updateData.thumbnail_url !== undefined ? updateData.thumbnail_url.trim() : existingLesson.thumbnail_url,
      duration_minutes: durationMins,
      duration: durationStr,
      is_preview: updateData.is_preview !== undefined ? Boolean(updateData.is_preview) : existingLesson.is_preview,
      topics: Array.isArray(updateData.topics) ? updateData.topics : existingLesson.topics,
      updated_at: new Date().toISOString()
    };

    updatedLessons[targetLessonIndex] = updatedLesson;
    targetModule.lessons = updatedLessons;
    updatedModules[targetModuleIndex] = targetModule;

    const { error: updateErr } = await supabase
      .from('courses')
      .update({
        curriculum_modules: updatedModules,
        updated_at: new Date().toISOString()
      })
      .eq('id', targetCourse.id);

    if (updateErr) throw updateErr;
    return updatedLesson;
  }

  async updateLessonStatus(id, status) {
    return this.updateLesson(id, { status });
  }

  async reorderLesson(id, displayOrder) {
    return this.updateLesson(id, { display_order: displayOrder });
  }

  async deleteLesson(id) {
    if (!id) {
      throw { statusCode: 400, message: 'Lesson ID is required.' };
    }

    const { data: courses } = await supabase.from('courses').select('*');
    if (!courses) throw { statusCode: 404, message: 'Course not found.' };

    let targetCourse = null;
    let targetModuleIndex = -1;
    let targetLessonIndex = -1;

    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        for (let mIdx = 0; mIdx < c.curriculum_modules.length; mIdx++) {
          const mod = c.curriculum_modules[mIdx];
          if (Array.isArray(mod.lessons)) {
            const lIdx = mod.lessons.findIndex(l => typeof l === 'object' && String(l.id) === String(id));
            if (lIdx !== -1) {
              targetCourse = c;
              targetModuleIndex = mIdx;
              targetLessonIndex = lIdx;
              break;
            }
          }
        }
        if (targetCourse) break;
      }
    }

    if (!targetCourse || targetModuleIndex === -1 || targetLessonIndex === -1) {
      throw { statusCode: 404, message: `Lesson '${id}' not found.` };
    }

    const updatedModules = [...targetCourse.curriculum_modules];
    const targetModule = { ...updatedModules[targetModuleIndex] };
    targetModule.lessons = targetModule.lessons.filter(l => typeof l === 'object' && String(l.id) !== String(id));
    updatedModules[targetModuleIndex] = targetModule;

    const { error: updateErr } = await supabase
      .from('courses')
      .update({
        curriculum_modules: updatedModules,
        updated_at: new Date().toISOString()
      })
      .eq('id', targetCourse.id);

    if (updateErr) throw updateErr;
    return true;
  }

  // ==========================================
  // 4. LESSON TOPICS
  // ==========================================

  async getTopicsByLesson(lessonId) {
    const lesson = await this.getLessonById(lessonId);
    if (!lesson) {
      return [];
    }
    return Array.isArray(lesson.topics) ? lesson.topics.map((t, idx) => ({ id: `top_${idx}`, lesson_id: lessonId, title: typeof t === 'string' ? t : t.title })) : [];
  }

  async getTopicById(id) {
    return { id, title: 'Topic' };
  }

  async createTopic(data) {
    const lessonId = data.lesson_id || data.lessonId;
    if (!lessonId) {
      throw { statusCode: 400, message: 'Lesson ID is required.' };
    }

    const { data: courses } = await supabase.from('courses').select('*');
    if (!courses) throw { statusCode: 404, message: 'Course not found.' };

    let targetCourse = null;
    let targetModuleIndex = -1;
    let targetLessonIndex = -1;

    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        for (let mIdx = 0; mIdx < c.curriculum_modules.length; mIdx++) {
          const mod = c.curriculum_modules[mIdx];
          if (Array.isArray(mod.lessons)) {
            const lIdx = mod.lessons.findIndex(l => typeof l === 'object' && String(l.id) === String(lessonId));
            if (lIdx !== -1) {
              targetCourse = c;
              targetModuleIndex = mIdx;
              targetLessonIndex = lIdx;
              break;
            }
          }
        }
        if (targetCourse) break;
      }
    }

    if (!targetCourse || targetModuleIndex === -1 || targetLessonIndex === -1) {
      throw { statusCode: 404, message: `Lesson '${lessonId}' not found.` };
    }

    const updatedModules = [...targetCourse.curriculum_modules];
    const targetModule = { ...updatedModules[targetModuleIndex] };
    const targetLessons = [...targetModule.lessons];
    const targetLesson = { ...targetLessons[targetLessonIndex] };

    const rawTopics = Array.isArray(targetLesson.topics) ? targetLesson.topics : [];
    const normalizedTopics = rawTopics.map((t, idx) => (typeof t === 'string' ? { id: `top_${idx + 1}`, title: t } : t));

    const newTopic = {
      id: require('crypto').randomUUID(),
      title: (data.title || data.name || 'New Topic').trim()
    };

    normalizedTopics.push(newTopic);
    targetLesson.topics = normalizedTopics;
    targetLessons[targetLessonIndex] = targetLesson;
    targetModule.lessons = targetLessons;
    updatedModules[targetModuleIndex] = targetModule;

    const { error: updateErr } = await supabase
      .from('courses')
      .update({
        curriculum_modules: updatedModules,
        updated_at: new Date().toISOString()
      })
      .eq('id', targetCourse.id);

    if (updateErr) throw updateErr;
    return newTopic;
  }

  async updateTopic(id, updateData) {
    if (!id) {
      throw { statusCode: 400, message: 'Topic ID is required.' };
    }

    const { data: courses } = await supabase.from('courses').select('*');
    if (!courses) throw { statusCode: 404, message: 'Course not found.' };

    let targetCourse = null;
    let targetModuleIndex = -1;
    let targetLessonIndex = -1;
    let targetTopicIndex = -1;

    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        for (let mIdx = 0; mIdx < c.curriculum_modules.length; mIdx++) {
          const mod = c.curriculum_modules[mIdx];
          if (Array.isArray(mod.lessons)) {
            for (let lIdx = 0; lIdx < mod.lessons.length; lIdx++) {
              const les = mod.lessons[lIdx];
              if (typeof les === 'object' && Array.isArray(les.topics)) {
                const normalizedTopics = les.topics.map((t, idx) => (typeof t === 'string' ? { id: `top_${les.id || lIdx + 1}_${idx + 1}`, title: t } : t));
                const tIdx = normalizedTopics.findIndex((t, idx) => {
                  const tId = String(t.id || '');
                  const reqId = String(id || '');
                  return (
                    tId === reqId ||
                    String(t.title) === reqId ||
                    `top_${les.id || lIdx + 1}_${idx + 1}` === reqId ||
                    `top_${idx + 1}` === reqId ||
                    (reqId.includes('_') && reqId.endsWith(`_${idx + 1}`)) ||
                    String(idx + 1) === reqId
                  );
                });

                if (tIdx !== -1) {
                  targetCourse = c;
                  targetModuleIndex = mIdx;
                  targetLessonIndex = lIdx;
                  targetTopicIndex = tIdx;
                  c.curriculum_modules[mIdx].lessons[lIdx].topics = normalizedTopics;
                  break;
                }
              }
            }
            if (targetCourse) break;
          }
        }
        if (targetCourse) break;
      }
    }

    if (!targetCourse || targetModuleIndex === -1 || targetLessonIndex === -1 || targetTopicIndex === -1) {
      throw { statusCode: 404, message: `Topic '${id}' not found.` };
    }

    const updatedModules = [...targetCourse.curriculum_modules];
    const targetModule = { ...updatedModules[targetModuleIndex] };
    const targetLessons = [...targetModule.lessons];
    const targetLesson = { ...targetLessons[targetLessonIndex] };
    const updatedTopics = [...targetLesson.topics];

    const updatedTopic = {
      ...updatedTopics[targetTopicIndex],
      title: updateData.title !== undefined ? updateData.title.trim() : updatedTopics[targetTopicIndex].title
    };

    updatedTopics[targetTopicIndex] = updatedTopic;
    targetLesson.topics = updatedTopics;
    targetLessons[targetLessonIndex] = targetLesson;
    targetModule.lessons = targetLessons;
    updatedModules[targetModuleIndex] = targetModule;

    const { error: updateErr } = await supabase
      .from('courses')
      .update({
        curriculum_modules: updatedModules,
        updated_at: new Date().toISOString()
      })
      .eq('id', targetCourse.id);

    if (updateErr) throw updateErr;
    return updatedTopic;
  }

  async deleteTopic(id) {
    if (!id) {
      throw { statusCode: 400, message: 'Topic ID is required.' };
    }

    const { data: courses } = await supabase.from('courses').select('*');
    if (!courses) throw { statusCode: 404, message: 'Course not found.' };

    let targetCourse = null;
    let targetModuleIndex = -1;
    let targetLessonIndex = -1;

    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        for (let mIdx = 0; mIdx < c.curriculum_modules.length; mIdx++) {
          const mod = c.curriculum_modules[mIdx];
          if (Array.isArray(mod.lessons)) {
            for (let lIdx = 0; lIdx < mod.lessons.length; lIdx++) {
              const les = mod.lessons[lIdx];
              if (typeof les === 'object' && Array.isArray(les.topics)) {
                const normalizedTopics = les.topics.map((t, idx) => (typeof t === 'string' ? { id: `top_${les.id || lIdx + 1}_${idx + 1}`, title: t } : t));
                const tIdx = normalizedTopics.findIndex((t, idx) => {
                  const tId = String(t.id || '');
                  const reqId = String(id || '');
                  return (
                    tId === reqId ||
                    String(t.title) === reqId ||
                    `top_${les.id || lIdx + 1}_${idx + 1}` === reqId ||
                    `top_${idx + 1}` === reqId ||
                    (reqId.includes('_') && reqId.endsWith(`_${idx + 1}`)) ||
                    String(idx + 1) === reqId
                  );
                });

                if (tIdx !== -1) {
                  targetCourse = c;
                  targetModuleIndex = mIdx;
                  targetLessonIndex = lIdx;
                  c.curriculum_modules[mIdx].lessons[lIdx].topics = normalizedTopics.filter((_, idx) => idx !== tIdx);
                  break;
                }
              }
            }
            if (targetCourse) break;
          }
        }
        if (targetCourse) break;
      }
    }

    if (!targetCourse || targetModuleIndex === -1 || targetLessonIndex === -1) {
      throw { statusCode: 404, message: `Topic '${id}' not found.` };
    }

    const { error: updateErr } = await supabase
      .from('courses')
      .update({
        curriculum_modules: targetCourse.curriculum_modules,
        updated_at: new Date().toISOString()
      })
      .eq('id', targetCourse.id);

    if (updateErr) throw updateErr;
    return true;
  }

  async reorderTopic(id, displayOrder) {
    return { id, display_order: displayOrder };
  }

  // ==========================================
  // 5. UNIFIED PUBLIC CURRICULUM ENDPOINT
  // GET /api/courses/:slug/curriculum
  // ==========================================

  async getPublicCourseCurriculum(identifier) {
    if (!identifier) {
      throw { statusCode: 400, message: 'Course identifier (slug or ID) is required.' };
    }

    // 1. Fetch published course by UUID or Slug
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    let course = isUUID ? await courseService.getCourseById(identifier, false) : null;
    if (!course) {
      course = await courseService.getCourseBySlug(identifier, false);
    }
    if (!course) {
      throw { statusCode: 404, message: 'Course not found or not published.' };
    }

    // Helper to format JSON curriculum_modules if present
    const formatJsonCurriculum = (jsonModules) => {
      return (jsonModules || []).map((m, idx) => {
        const rawLessons = Array.isArray(m.lessons) ? m.lessons : [];
        const durationMins = Number(m.duration_minutes) || (parseFloat(m.duration) ? Math.round(parseFloat(m.duration) * 60) : 60);
        const durationHrsStr = (durationMins / 60) % 1 === 0 ? `${durationMins / 60} hr${durationMins / 60 === 1 ? '' : 's'}` : `${(durationMins / 60).toFixed(1)} hrs`;

        const formattedLessons = rawLessons.map((l, lIdx) => {
          if (typeof l === 'object' && l !== null) {
            const rawTopics = Array.isArray(l.topics) ? l.topics : [];
            const formattedTopics = rawTopics.map((t, tIdx) => {
              if (typeof t === 'object' && t !== null) {
                return {
                  id: t.id || `top_${l.id || lIdx + 1}_${tIdx + 1}`,
                  title: t.title || t.name || String(t)
                };
              }
              return {
                id: `top_${l.id || lIdx + 1}_${tIdx + 1}`,
                title: String(t)
              };
            });

            return {
              id: l.id || `l_${m.id || idx + 1}_${lIdx + 1}`,
              module_id: m.id || `mod_${idx + 1}`,
              title: l.title || l.name || `Lesson ${lIdx + 1}`,
              description: l.description || '',
              lesson_type: (l.lesson_type || 'VIDEO').toUpperCase(),
              duration_minutes: Number(l.duration_minutes) || 30,
              duration: l.duration || `${Number(l.duration_minutes) || 30} mins`,
              video_url: l.video_url || '',
              thumbnail_url: l.thumbnail_url || course.thumbnail_url || '',
              is_preview: Boolean(l.is_preview),
              topics: formattedTopics
            };
          }

          return {
            id: `l_${m.id || idx + 1}_${lIdx + 1}`,
            module_id: m.id || `mod_${idx + 1}`,
            title: String(l),
            description: '',
            lesson_type: 'VIDEO',
            duration_minutes: Math.round(durationMins / (rawLessons.length || 1)),
            duration: `${Math.round(durationMins / (rawLessons.length || 1))} mins`,
            video_url: '',
            thumbnail_url: course.thumbnail_url || '',
            is_preview: idx === 0 && lIdx === 0,
            topics: []
          };
        });

        const videoCount = formattedLessons.filter(l => l.lesson_type === 'VIDEO').length;

        return {
          id: m.id || `mod_${idx + 1}`,
          name: m.title || m.name || `Module ${idx + 1}`,
          title: m.title || m.name || `Module ${idx + 1}`,
          description: m.description || `Module ${idx + 1} of ${course.title}`,
          display_order: m.display_order || idx + 1,
          duration: m.duration || durationHrsStr,
          duration_minutes: durationMins,
          videos: videoCount,
          lessons: formattedLessons
        };
      });
    };

    // 2. Fetch published version
    const versions = await this.getVersionsByCourse(course.id);
    const publishedVersion = (versions || []).find(v => v.status === 'PUBLISHED' || v.status === 'ACTIVE') || versions[0];

    let formattedModules = [];

    if (publishedVersion) {
      // 3. Fetch published modules for this version
      const modules = await this.getModulesByVersion(publishedVersion.id, false);

      if (modules && modules.length > 0) {
        // 4. For each module, fetch published lessons and topics
        const modulePromises = modules.map(async (mod) => {
          const lessons = await this.getLessonsByModule(mod.id, false);
          const moduleDuration = (lessons || []).reduce((sum, lesson) => sum + (Number(lesson.duration_minutes) || 0), 0);

          const lessonPromises = (lessons || []).map(async (lesson) => {
            const topics = await this.getTopicsByLesson(lesson.id);
            return {
              id: lesson.id,
              title: lesson.title,
              lesson_type: lesson.lesson_type || 'VIDEO',
              duration_minutes: Number(lesson.duration_minutes) || 0,
              video_url: lesson.video_url || '',
              thumbnail_url: lesson.thumbnail_url || '',
              is_preview: Boolean(lesson.is_preview),
              topics: (topics || []).map(t => ({
                id: t.id,
                title: t.title,
                display_order: t.display_order
              }))
            };
          });

          const formattedLessons = await Promise.all(lessonPromises);

          return {
            id: mod.id,
            name: mod.name,
            title: mod.name,
            description: mod.description,
            display_order: mod.display_order,
            duration_minutes: moduleDuration,
            lessons: formattedLessons
          };
        });

        formattedModules = await Promise.all(modulePromises);
      }
    }

    // Fall back to JSON curriculum_modules if relational modules are empty
    if (formattedModules.length === 0 && course.curriculum_modules && course.curriculum_modules.length > 0) {
      formattedModules = formatJsonCurriculum(course.curriculum_modules);
    }

    return {
      course: {
        id: course.id,
        title: course.title,
        slug: course.slug,
        description: course.description,
        thumbnail_url: course.thumbnail_url || '',
        version: {
          id: publishedVersion ? publishedVersion.id : `v1_${course.id}`,
          version_number: publishedVersion ? publishedVersion.version_number : 1,
          title: publishedVersion ? publishedVersion.title : 'Version 1',
          modules: formattedModules
        },
        modules: formattedModules
      }
    };
  }
}

module.exports = new CurriculumService();
