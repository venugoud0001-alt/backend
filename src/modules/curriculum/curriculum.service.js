const { supabase } = require('../../config/supabase');
const { generateSlug } = require('../../utils/slug');
const { classifyIdentifier, normalizeIdentifier, isUUID } = require('../../utils/idValidator');
const courseService = require('../courses/course.service');
const crypto = require('crypto');

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

/** Assign a real UUID when curriculum JSON still has mod_1 / missing ids. */
function ensureStableModuleId(mod) {
  if (!mod || typeof mod !== 'object') return null;
  const current = String(mod.id || '').trim();
  if (isUUID(current)) return current;
  const nextId = crypto.randomUUID();
  mod.id = nextId;
  return nextId;
}

/** Short TTL cache for student public curriculum (avoids repeat heavy enrichment after deploy) */
const publicCurriculumCache = new Map();
const PUBLIC_CURRICULUM_TTL_MS = Number(process.env.CURRICULUM_CACHE_TTL_MS) || 90 * 1000;

function getCachedPublicCurriculum(key) {
  const hit = publicCurriculumCache.get(String(key));
  if (!hit) return null;
  if (Date.now() - hit.at > PUBLIC_CURRICULUM_TTL_MS) {
    publicCurriculumCache.delete(String(key));
    return null;
  }
  return hit.payload;
}

function setCachedPublicCurriculum(key, payload) {
  publicCurriculumCache.set(String(key), { at: Date.now(), payload });
}

/** Persist UUID repairs for modules stored without stable ids. */
async function healCourseModuleIds(course) {
  if (!course?.id || !Array.isArray(course.curriculum_modules)) return false;
  let changed = false;
  const next = course.curriculum_modules.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const copy = { ...m };
    const before = String(copy.id || '').trim();
    if (!isUUID(before)) {
      copy.id = crypto.randomUUID();
      changed = true;
    }
    return copy;
  });
  if (!changed) return false;
  const { error } = await supabase
    .from('courses')
    .update({
      curriculum_modules: next,
      updated_at: new Date().toISOString()
    })
    .eq('id', course.id);
  if (error) throw error;
  course.curriculum_modules = next;
  return true;
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
    try {
      await healCourseModuleIds(course);
    } catch (healErr) {
      console.warn('⚠️ [Modules] Could not heal module UUIDs:', healErr.message || healErr);
    }
    return course.curriculum_modules.map((mod, idx) => ({
      id: (isUUID(String(mod.id || '').trim()) ? String(mod.id).trim() : (mod.id || `mod_${idx + 1}`)),
      name: mod.name || mod.title || `Module ${idx + 1}`,
      title: mod.title || mod.name || `Module ${idx + 1}`,
      description: mod.description || '',
      duration_minutes: mod.duration_minutes || 60,
      duration_hours: mod.duration_hours || Math.round(((mod.duration_minutes || 60) / 60) * 10) / 10,
      duration: mod.duration || '1 hr',
      video_url: mod.video_url || '',
      video_status: mod.video_status || (mod.video_url ? 'READY' : 'NO_VIDEO'),
      video_title: mod.video_title || mod.title || mod.name || `Module ${idx + 1} Video`,
      video_asset_id: mod.video_asset_id || null,
      video_error_message: mod.video_error_message || '',
      video_content_mode: mod.video_content_mode || 'SINGLE_MODULE_VIDEO',
      topics: Array.isArray(mod.topics) ? mod.topics : (Array.isArray(mod.lessons) ? mod.lessons : []),
      lessons: Array.isArray(mod.lessons) ? mod.lessons : (Array.isArray(mod.topics) ? mod.topics : []),
      is_preview: Boolean(mod.is_preview || mod.is_free_preview),
      is_free_preview: Boolean(mod.is_preview || mod.is_free_preview),
      is_published: mod.is_published !== undefined ? Boolean(mod.is_published) : true
    }));
  }

  async getModuleById(id, explicitCourseId = null) {
    if (!id) return null;
    const cleanId = String(id).trim().toLowerCase();

    if (explicitCourseId) {
      const course = (await courseService.getCourseById(explicitCourseId, true).catch(() => null)) ||
                     (await courseService.getCourseBySlug(explicitCourseId, true).catch(() => null));
      if (course && Array.isArray(course.curriculum_modules)) {
        const mod = course.curriculum_modules.find((m, idx) =>
          String(m.id || '').trim().toLowerCase() === cleanId ||
          `mod_${idx + 1}`.toLowerCase() === cleanId ||
          String(idx + 1) === cleanId
        );
        if (mod) return { ...mod, id: mod.id || `mod_${id}`, course_id: course.id };
      }
      return null;
    }

    // If no courseId is provided, reject all legacy identifiers (numeric, mod_X, slugs, etc.)
    // Only strictly valid UUIDs are globally searchable
    if (!isUUID(cleanId)) {
      return null;
    }

    const { data: courses } = await supabase.from('courses').select('id, curriculum_modules');
    if (!courses) return null;
    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        const mod = c.curriculum_modules.find((m) => m && String(m.id).toLowerCase() === cleanId);
        if (mod) return { ...mod, id: mod.id, course_id: c.id };
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

    const cleanCourseId = String(courseId).trim();
    const classification = classifyIdentifier(cleanCourseId);
    let courseQuery = supabase.from('courses').select('*');
    if (classification === 'UUID') {
      courseQuery = courseQuery.eq('id', cleanCourseId);
    } else if (classification !== 'INVALID') {
      courseQuery = courseQuery.eq('slug', normalizeIdentifier(cleanCourseId, 'SLUG'));
    } else {
      courseQuery = courseQuery.eq('id', cleanCourseId);
    }

    const { data: course, error: fetchErr } = await courseQuery.maybeSingle();

    if (fetchErr || !course) {
      throw { statusCode: 404, message: `Course not found: '${courseId}'` };
    }

    const existingModules = Array.isArray(course.curriculum_modules) ? [...course.curriculum_modules] : [];
    const incomingTitle = String(data.title || data.name || '').trim();
    if (!incomingTitle) {
      throw { statusCode: 400, message: 'Module title is required.' };
    }

    const normalizeTitle = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const incomingKey = normalizeTitle(incomingTitle);
    const duplicate = existingModules.find((m) => {
      const existingKey = normalizeTitle(m?.title || m?.name);
      return existingKey && existingKey === incomingKey;
    });

    if (duplicate) {
      // Legacy rows may exist without a UUID — repair in place so clients can link instead of recreating.
      const beforeId = String(duplicate.id || '').trim();
      if (!isUUID(beforeId)) {
        ensureStableModuleId(duplicate);
        const { error: healErr } = await supabase
          .from('courses')
          .update({
            curriculum_modules: existingModules,
            updated_at: new Date().toISOString()
          })
          .eq('id', course.id);
        if (healErr) throw healErr;
      }

      throw {
        statusCode: 409,
        code: 'MODULE_TITLE_EXISTS',
        message: `A module titled "${duplicate.title || duplicate.name}" already exists in this course. Edit the existing module instead of creating a duplicate.`,
        details: {
          course_id: course.id,
          existing_module_id: duplicate.id || null,
          existing_title: duplicate.title || duplicate.name || incomingTitle
        }
      };
    }

    const newModuleId = crypto.randomUUID();
    const durationMins = Number(data.duration_minutes) || (Number(data.duration_hours) ? Math.round(Number(data.duration_hours) * 60) : 60);
    const durationHrsStr = (durationMins / 60) % 1 === 0 ? `${durationMins / 60} hr${durationMins / 60 === 1 ? '' : 's'}` : `${(durationMins / 60).toFixed(1)} hrs`;

    const newModule = {
      id: newModuleId,
      name: data.name || data.title,
      title: data.title || data.name,
      description: data.description || '',
      duration: data.duration || durationHrsStr,
      duration_minutes: durationMins,
      duration_hours: Math.round((durationMins / 60) * 10) / 10,
      display_order: existingModules.length + 1,
      video_url: data.video_url || '',
      video_status: data.video_status || (data.video_url ? 'READY' : 'NO_VIDEO'),
      video_title: data.video_title || data.title || data.name,
      video_asset_id: data.video_asset_id || null,
      video_error_message: data.video_error_message || '',
      video_content_mode: data.video_content_mode || 'SINGLE_MODULE_VIDEO',
      topics: Array.isArray(data.topics) ? data.topics : (Array.isArray(data.lessons) ? data.lessons : []),
      lessons: Array.isArray(data.lessons) ? data.lessons : (Array.isArray(data.topics) ? data.topics : []),
      is_preview: Boolean(data.is_preview !== undefined ? data.is_preview : data.is_free_preview),
      is_free_preview: Boolean(data.is_preview !== undefined ? data.is_preview : data.is_free_preview),
      is_published: data.is_published !== undefined ? Boolean(data.is_published) : true,
      updated_at: new Date().toISOString()
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

  async updateModule(id, updateData, explicitCourseId = null) {
    if (!id) {
      throw { statusCode: 400, message: 'Module ID is required.' };
    }

    const targetCourseId = explicitCourseId || updateData?.course_id || updateData?.courseId;
    if (!targetCourseId) {
      throw { statusCode: 400, message: 'course_id is required to update a module.' };
    }

    const targetCourse = (await courseService.getCourseById(targetCourseId, true).catch(() => null)) ||
                         (await courseService.getCourseBySlug(targetCourseId, true).catch(() => null));
    if (!targetCourse) {
      throw { statusCode: 404, message: `Course '${targetCourseId}' not found.` };
    }

    if (!Array.isArray(targetCourse.curriculum_modules) || targetCourse.curriculum_modules.length === 0) {
      throw { statusCode: 404, message: `Module '${id}' not found in course '${targetCourse.title}'.` };
    }

    const cleanTarget = String(id).trim().toLowerCase();
    const targetModuleIndex = targetCourse.curriculum_modules.findIndex((m, mIdx) => {
      if (!m) return false;
      const mId = String(m.id || '').trim().toLowerCase();
      if (mId === cleanTarget) return true;
      if (`mod_${mIdx + 1}`.toLowerCase() === cleanTarget) return true;
      if (String(mIdx + 1) === cleanTarget) return true;
      if (m.id && `mod_${m.id}`.toLowerCase() === cleanTarget) return true;
      return false;
    });

    if (targetModuleIndex === -1) {
      throw { statusCode: 404, message: `Module '${id}' does not belong to course '${targetCourse.title}' (${targetCourse.id}).` };
    }

    if (!targetCourse.curriculum_modules[targetModuleIndex].id) {
      targetCourse.curriculum_modules[targetModuleIndex].id = id;
    }

    const updatedModules = [...targetCourse.curriculum_modules];
    const existingMod = updatedModules[targetModuleIndex];

    const nextTitle = String(updateData.title || updateData.name || existingMod.title || existingMod.name || '').trim();
    if (nextTitle) {
      const normalizeTitle = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const nextKey = normalizeTitle(nextTitle);
      const conflicting = updatedModules.find((m, idx) => {
        if (idx === targetModuleIndex || !m) return false;
        return normalizeTitle(m.title || m.name) === nextKey;
      });
      if (conflicting) {
        throw {
          statusCode: 409,
          code: 'MODULE_TITLE_EXISTS',
          message: `Another module titled "${conflicting.title || conflicting.name}" already exists in this course. Choose a different name.`,
          details: {
            course_id: targetCourse.id,
            existing_module_id: conflicting.id || null,
            existing_title: conflicting.title || conflicting.name || nextTitle
          }
        };
      }
    }

    const durationMins = updateData.duration_minutes !== undefined
      ? Number(updateData.duration_minutes)
      : (updateData.duration_hours ? Math.round(Number(updateData.duration_hours) * 60) : existingMod.duration_minutes || 60);

    const durationHrsStr = (durationMins / 60) % 1 === 0
      ? `${durationMins / 60} hr${durationMins / 60 === 1 ? '' : 's'}`
      : `${(durationMins / 60).toFixed(1)} hrs`;

    let cleanLessons = Array.isArray(updateData.lessons)
      ? updateData.lessons
      : (Array.isArray(updateData.topics) ? updateData.topics : (existingMod.lessons || []));

    const isExplicitlyNoVideo = updateData.video_status === 'NO_VIDEO' || (updateData.video_url === '' && updateData.video_status !== 'READY');

    let cleanTopics = Array.isArray(updateData.topics)
      ? updateData.topics
      : (existingMod.topics || existingMod.lessons || []);

    if (isExplicitlyNoVideo && Array.isArray(cleanTopics)) {
      cleanTopics = cleanTopics.map(t => {
        if (typeof t === 'object' && t !== null) {
          return {
            ...t,
            hls_master_url: null,
            hls_prefix: null,
            hls_720p_url: null,
            hls_1080p_url: null,
            processing_status: 'DRAFT'
          };
        }
        return t;
      });
    }

    // If video_url is explicitly updated or cleared, sync all child lesson objects
    if (updateData.video_url !== undefined && Array.isArray(cleanLessons)) {
      cleanLessons = cleanLessons.map(l => {
        if (typeof l === 'object' && l !== null) {
          return {
            ...l,
            video_url: updateData.video_url,
            video_status: updateData.video_status || (updateData.video_url ? 'READY' : 'NO_VIDEO'),
            video_asset_id: updateData.video_asset_id !== undefined ? updateData.video_asset_id : null,
            video_error_message: updateData.video_error_message !== undefined ? updateData.video_error_message : ''
          };
        }
        return l;
      });
    }

    const updatedMod = {
      ...existingMod,
      name: updateData.name || updateData.title || existingMod.name || existingMod.title,
      title: updateData.title || updateData.name || existingMod.title || existingMod.name,
      description: updateData.description !== undefined ? updateData.description : existingMod.description,
      duration_minutes: durationMins,
      duration: updateData.duration || durationHrsStr,
      duration_hours: Math.round((durationMins / 60) * 10) / 10,
      video_url: updateData.video_url !== undefined ? updateData.video_url : (isExplicitlyNoVideo ? '' : (existingMod.video_url || '')),
      video_status: updateData.video_status !== undefined ? updateData.video_status : (isExplicitlyNoVideo ? 'NO_VIDEO' : (existingMod.video_status || (existingMod.video_url ? 'READY' : 'NO_VIDEO'))),
      video_title: updateData.video_title !== undefined ? updateData.video_title : (existingMod.video_title || existingMod.title),
      video_asset_id: isExplicitlyNoVideo ? null : (updateData.video_asset_id !== undefined ? updateData.video_asset_id : (existingMod.video_asset_id || null)),
      video_error_message: isExplicitlyNoVideo ? '' : (updateData.video_error_message !== undefined ? updateData.video_error_message : (existingMod.video_error_message || '')),
      video_content_mode: updateData.video_content_mode !== undefined ? updateData.video_content_mode : (existingMod.video_content_mode || 'SINGLE_MODULE_VIDEO'),
      hasVideo: !isExplicitlyNoVideo && Boolean(updateData.video_url || existingMod.video_url),
      topics: cleanTopics,
      lessons: cleanLessons,
      is_preview: updateData.is_preview !== undefined
        ? Boolean(updateData.is_preview)
        : (updateData.is_free_preview !== undefined
          ? Boolean(updateData.is_free_preview)
          : Boolean(existingMod.is_preview || existingMod.is_free_preview)),
      is_free_preview: updateData.is_free_preview !== undefined
        ? Boolean(updateData.is_free_preview)
        : (updateData.is_preview !== undefined
          ? Boolean(updateData.is_preview)
          : Boolean(existingMod.is_free_preview || existingMod.is_preview)),
      is_published: updateData.is_published !== undefined ? Boolean(updateData.is_published) : (existingMod.is_published !== undefined ? Boolean(existingMod.is_published) : true),
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

    // ARCH-05: Synchronize relational module table if record exists
    try {
      if (updatedMod.id && /^[0-9a-f-]{36}$/i.test(String(updatedMod.id))) {
        await supabase
          .from('modules')
          .update({
            name: updatedMod.title || updatedMod.name,
            description: updatedMod.description || '',
            updated_at: new Date().toISOString()
          })
          .eq('id', updatedMod.id);
      }
    } catch (syncRelErr) {
      // Non-blocking sync note
    }

    // ARCH-06: Synchronize topics table in Supabase when topics are updated, renamed, or deleted
    if (Array.isArray(cleanTopics)) {
      try {
        const modIdStr = String(updatedMod.id);
        const modNumStr = String(targetModuleIndex + 1);

        // Fetch only DB topics specifically belonging to this course and this module
        let topicQuery = supabase
          .from('topics')
          .select('id, display_order, title')
          .eq('course_id', targetCourse.id);

        if (modIdStr === modNumStr) {
          topicQuery = topicQuery.eq('module_id', modIdStr);
        } else {
          topicQuery = topicQuery.or(`module_id.eq.${modIdStr},module_id.eq.${modNumStr}`);
        }

        const { data: dbModTopics } = await topicQuery;

        if (Array.isArray(dbModTopics) && dbModTopics.length > 0) {
          const sortedDbModTopics = [...dbModTopics].sort((a, b) => (Number(a.display_order) || 0) - (Number(b.display_order) || 0));
          const topicUpdatePromises = [];

          for (let tIdx = 0; tIdx < cleanTopics.length; tIdx++) {
            const t = cleanTopics[tIdx];
            const title = typeof t === 'object' && t !== null ? (t.title || t.name) : String(t || '');
            if (!title || !title.trim()) continue;
            const cleanTitle = title.trim();

            let targetDbTopic = null;
            // 1. Match by UUID ID
            if (typeof t === 'object' && t?.id) {
              targetDbTopic = sortedDbModTopics.find(dbT => String(dbT.id) === String(t.id));
            }
            // 2. Match by display_order
            if (!targetDbTopic && typeof t === 'object' && t?.display_order !== undefined) {
              targetDbTopic = sortedDbModTopics.find(dbT => Number(dbT.display_order) === Number(t.display_order));
            }
            // 3. Match by index
            if (!targetDbTopic && sortedDbModTopics[tIdx]) {
              targetDbTopic = sortedDbModTopics[tIdx];
            }

            if (targetDbTopic && targetDbTopic.title !== cleanTitle) {
              topicUpdatePromises.push(
                supabase
                  .from('topics')
                  .update({
                    title: cleanTitle,
                    updated_at: new Date().toISOString()
                  })
                  .eq('id', targetDbTopic.id)
              );
            }
          }

          if (topicUpdatePromises.length > 0) {
            await Promise.all(topicUpdatePromises);
          }

          // Clean up removed topics from DB if topics array shrank
          if (cleanTopics.length < sortedDbModTopics.length) {
            const remainingIds = new Set(
              cleanTopics.map(t => (typeof t === 'object' && t !== null ? t.id : null)).filter(Boolean)
            );
            const deleteIds = [];
            if (remainingIds.size > 0) {
              for (const dbT of sortedDbModTopics) {
                if (!remainingIds.has(dbT.id)) {
                  deleteIds.push(dbT.id);
                }
              }
            } else {
              for (let i = cleanTopics.length; i < sortedDbModTopics.length; i++) {
                deleteIds.push(sortedDbModTopics[i].id);
              }
            }
            if (deleteIds.length > 0) {
              await supabase.from('topics').delete().in('id', deleteIds);
            }
          }
        }
      } catch (topicSyncErr) {
        console.warn('⚠️ [updateModule] Notice syncing topics table:', topicSyncErr.message);
      }
    }

    return updatedMod;
  }

  async updateModuleStatus(id, status) {
    return this.updateModule(id, { status });
  }

  async reorderModule(id, displayOrder) {
    return this.updateModule(id, { display_order: displayOrder });
  }

  async deleteModule(id, courseId = null, options = {}) {
    const force = Boolean(options?.force);
    if (!id) {
      throw { statusCode: 400, message: 'Module ID is required.' };
    }

    console.log(`\n[MODULE DELETE AUDIT] Request - moduleId: '${id}', courseId: '${courseId || 'UNSPECIFIED'}', force=${force}`);

    if (!courseId) {
      throw { statusCode: 400, message: 'course_id is required to delete a module. Global module deletion across courses is strictly prohibited.' };
    }

    const cleanCourseId = String(courseId).trim();
    const classification = classifyIdentifier(cleanCourseId);
    if (classification === 'INVALID') {
      throw { statusCode: 400, message: 'Invalid course identifier format.' };
    }

    let courseQuery = supabase.from('courses').select('*');
    if (classification === 'UUID') {
      courseQuery = courseQuery.eq('id', cleanCourseId);
    } else {
      courseQuery = courseQuery.eq('slug', normalizeIdentifier(cleanCourseId, 'SLUG'));
    }
    const { data: targetCourse, error: cErr } = await courseQuery.maybeSingle();
    if (cErr || !targetCourse) {
      throw { statusCode: 404, message: `Course not found for identifier '${courseId}'.` };
    }

    let targetModuleIndex = -1;

    const matchesModule = (m, mIdx) => {
      if (!m) return false;
      const cleanTarget = String(id).trim().toLowerCase();
      const mId = String(m.id || '').trim().toLowerCase();
      const mTitle = String(m.title || m.name || '').trim().toLowerCase();
      const fallbackId = `mod_${mIdx + 1}`.toLowerCase();
      const indexStr = String(mIdx + 1);

      // 1. Explicit ID Matching (Exact UUID or string ID)
      if (m.id && String(m.id).trim().toLowerCase() === cleanTarget) {
        return true;
      }
      if (m.id && `mod_${m.id}`.toLowerCase() === cleanTarget) {
        return true;
      }
      if (mId && mId === cleanTarget) {
        return true;
      }

      // 2. Fallback matching ONLY IF m.id is missing or undefined
      if (!m.id) {
        if (fallbackId === cleanTarget) return true;
        if (indexStr === cleanTarget) return true;
        if (mTitle && mTitle === cleanTarget) return true;
      }

      return false;
    };

    if (Array.isArray(targetCourse.curriculum_modules)) {
      targetModuleIndex = targetCourse.curriculum_modules.findIndex((m, mIdx) => matchesModule(m, mIdx));
    }

    if (targetModuleIndex === -1) {
      throw {
        statusCode: 404,
        message: `Module '${id}' does not belong to course '${targetCourse.title}' (${targetCourse.id}). Module deletion rejected.`
      };
    }

    const targetModule = targetCourse.curriculum_modules[targetModuleIndex];
    const moduleLessons = Array.isArray(targetModule.lessons) ? targetModule.lessons : [];
    const moduleVideos = Array.isArray(targetModule.videos) ? targetModule.videos : [];
    const moduleTopics = Array.isArray(targetModule.topics) ? targetModule.topics : [];
    const totalChildCount = moduleLessons.length + moduleVideos.length + moduleTopics.length;

    console.log(`[MODULE DELETE AUDIT] Found Target Course: '${targetCourse.title}' (ID: ${targetCourse.id})`);
    console.log(`[MODULE DELETE AUDIT] Found Target Module: '${targetModule.title || targetModule.name}' (ID: ${targetModule.id || 'SYNTHETIC'})`);
    console.log(`[MODULE DELETE AUDIT] curriculum lesson count: ${moduleLessons.length}`);
    console.log(`[MODULE DELETE AUDIT] curriculum video count: ${moduleVideos.length}`);
    console.log(`[MODULE DELETE AUDIT] curriculum topic count: ${moduleTopics.length}`);
    console.log(`[MODULE DELETE AUDIT] dependency records count: ${totalChildCount}`);

    if (totalChildCount > 0 && !force) {
      console.log(`[MODULE DELETE AUDIT] REJECTING: Module '${id}' contains ${totalChildCount} child lessons/videos/topics.`);
      throw {
        statusCode: 422,
        code: 'MODULE_HAS_LESSONS',
        message: 'Cannot delete module because it contains lessons/topics. Use force=true to permanently delete the module and its children, or remove children first.',
        details: {
          course_id: targetCourse.id,
          module_id: id,
          lesson_count: moduleLessons.length,
          video_count: moduleVideos.length,
          topic_count: moduleTopics.length,
          force_supported: true
        }
      };
    }

    if (totalChildCount > 0 && force) {
      console.log(`[MODULE DELETE AUDIT] FORCE CASCADE: Removing module '${id}' with ${totalChildCount} nested children.`);
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

    // ARCH-06: Scoped cleanup of orphaned relational records (modules/lessons/lesson_topics) if present
    try {
      const { data: cVersions } = await supabase
        .from('course_versions')
        .select('id')
        .eq('course_id', targetCourse.id);

      if (cVersions && cVersions.length > 0) {
        const vIds = cVersions.map(v => v.id);
        const { data: relMods } = await supabase
          .from('modules')
          .select('id, name')
          .in('course_version_id', vIds);

        if (relMods && relMods.length > 0) {
          const modToDelete = relMods.find(rm =>
            rm.id === id ||
            (targetModule.id && rm.id === targetModule.id) ||
            rm.name === (targetModule.title || targetModule.name)
          );
          if (modToDelete) {
            const { data: relLessons } = await supabase
              .from('lessons')
              .select('id')
              .eq('module_id', modToDelete.id);

            if (relLessons && relLessons.length > 0) {
              const lIds = relLessons.map(l => l.id);
              await supabase.from('lesson_topics').delete().in('lesson_id', lIds);
              await supabase.from('lessons').delete().eq('module_id', modToDelete.id);
            }
            await supabase.from('modules').delete().eq('id', modToDelete.id);
          }
        }
      }
    } catch (relCleanupErr) {
      console.warn('[CURRICULUM ARCH-06] Relational module cleanup note:', relCleanupErr.message);
    }

    try {
      const courseService = require('../courses/course.service');
      courseService.clearCache();
    } catch (e) {
      // Ignore circular ref
    }

    return {
      success: true,
      message: force && totalChildCount > 0
        ? 'Module and nested lessons/topics deleted successfully'
        : 'Module deleted successfully',
      module_id: id,
      course_id: targetCourse.id,
      remaining_module_count: updatedModules.length,
      cascaded_children: force ? totalChildCount : 0
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

    const newTitle = (updateData?.title || updateData?.name || '').trim();

    // 1. Direct check in public.topics table (MediaConvert / Video Splitter topics)
    try {
      const { data: dbTopic } = await supabase.from('topics').select('*').eq('id', id).maybeSingle();
      if (dbTopic) {
        if (newTitle) {
          await supabase
            .from('topics')
            .update({ title: newTitle, updated_at: new Date().toISOString() })
            .eq('id', id);
        }

        // Also update in courses table curriculum_modules if course_id is known
        if (dbTopic.course_id) {
          const { data: c } = await supabase.from('courses').select('id, curriculum_modules').eq('id', dbTopic.course_id).maybeSingle();
          if (c && Array.isArray(c.curriculum_modules)) {
            let modUpdated = false;
            const updatedMods = c.curriculum_modules.map((m, mIdx) => {
              const modIdStr = String(m.id || mIdx + 1);
              if (String(dbTopic.module_id) === modIdStr || String(dbTopic.module_id) === String(mIdx + 1)) {
                if (Array.isArray(m.topics)) {
                  m.topics = m.topics.map(t => {
                    if (typeof t === 'object' && t !== null && (String(t.id) === String(id) || Number(t.display_order) === Number(dbTopic.display_order))) {
                      modUpdated = true;
                      return { ...t, title: newTitle, name: newTitle };
                    }
                    return t;
                  });
                }
              }
              return m;
            });
            if (modUpdated) {
              await supabase.from('courses').update({ curriculum_modules: updatedMods, updated_at: new Date().toISOString() }).eq('id', c.id);
            }
          }
        }
        return { ...dbTopic, title: newTitle, name: newTitle };
      }
    } catch (dbErr) {
      console.warn('⚠️ [updateTopic] Direct topics table lookup note:', dbErr.message);
    }

    // 2. Search in course versions and curriculum_modules
    const { data: courses } = await supabase.from('courses').select('*');
    if (!courses) throw { statusCode: 404, message: 'Course not found.' };

    let targetCourse = null;
    let targetModuleIndex = -1;
    let targetLessonIndex = -1;
    let targetTopicIndex = -1;
    let isModuleLevelTopic = false;

    for (const c of courses) {
      if (Array.isArray(c.curriculum_modules)) {
        for (let mIdx = 0; mIdx < c.curriculum_modules.length; mIdx++) {
          const mod = c.curriculum_modules[mIdx];

          // Check module-level topics
          if (Array.isArray(mod.topics)) {
            const tIdx = mod.topics.findIndex((t, idx) => {
              if (typeof t === 'object' && t !== null) {
                return String(t.id) === String(id) || String(t.title) === String(id) || `top_${idx + 1}` === String(id);
              }
              return String(t) === String(id) || `top_${idx + 1}` === String(id);
            });

            if (tIdx !== -1) {
              targetCourse = c;
              targetModuleIndex = mIdx;
              targetTopicIndex = tIdx;
              isModuleLevelTopic = true;
              break;
            }
          }

          // Check lesson-level topics
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

    if (!targetCourse || targetModuleIndex === -1 || targetTopicIndex === -1) {
      throw { statusCode: 404, message: `Topic '${id}' not found.` };
    }

    const updatedModules = [...targetCourse.curriculum_modules];
    const targetModule = { ...updatedModules[targetModuleIndex] };
    let updatedTopic = null;

    if (isModuleLevelTopic) {
      const rawTopics = [...targetModule.topics];
      const existing = rawTopics[targetTopicIndex];
      updatedTopic = typeof existing === 'object' && existing !== null
        ? { ...existing, title: newTitle || existing.title, name: newTitle || existing.name }
        : newTitle;
      rawTopics[targetTopicIndex] = updatedTopic;
      targetModule.topics = rawTopics;
    } else {
      const targetLessons = [...targetModule.lessons];
      const targetLesson = { ...targetLessons[targetLessonIndex] };
      const updatedTopics = [...targetLesson.topics];

      updatedTopic = {
        ...updatedTopics[targetTopicIndex],
        title: newTitle || updatedTopics[targetTopicIndex].title
      };

      updatedTopics[targetTopicIndex] = updatedTopic;
      targetLesson.topics = updatedTopics;
      targetLessons[targetLessonIndex] = targetLesson;
      targetModule.lessons = targetLessons;
    }

    updatedModules[targetModuleIndex] = targetModule;

    const { error: updateErr } = await supabase
      .from('courses')
      .update({
        curriculum_modules: updatedModules,
        updated_at: new Date().toISOString()
      })
      .eq('id', targetCourse.id);

    if (updateErr) throw updateErr;

    // Synchronize topics table directly if topic id exists
    try {
      if (id && newTitle) {
        await supabase
          .from('topics')
          .update({
            title: newTitle,
            updated_at: new Date().toISOString()
          })
          .eq('id', id);
      }
    } catch (e) {
      // ignore
    }

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
      // Check if this topic exists in public.topics table or public.topic_videos
      try {
        const { data: dbTopic } = await supabase.from('topics').select('id').eq('id', id).maybeSingle();
        if (dbTopic) {
          await supabase.from('topics').delete().eq('id', id);
          return { success: true, message: `Topic '${id}' deleted successfully from database.` };
        }
      } catch (dbErr) {
        // ignore
      }
      return { success: true, message: `Topic '${id}' deleted or already removed.` };
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

    const cacheKey = String(identifier).trim().toLowerCase();
    const cached = getCachedPublicCurriculum(cacheKey);
    if (cached) return cached;

    // 1. Fetch published course by UUID or Slug
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    let course = isUUID ? await courseService.getCourseById(identifier, false) : null;
    if (!course) {
      course = await courseService.getCourseBySlug(identifier, false);
    }
    if (!course) {
      throw { statusCode: 404, message: 'Course not found or not published.' };
    }

    // Never block student reads on heal writes — run in background if needed
    healCourseModuleIds(course).catch((healErr) => {
      console.warn('⚠️ [Curriculum Read] Could not heal module UUIDs:', healErr.message || healErr);
    });

    // Fetch real uploaded videos and topics for this course to enrich curriculum telemetry
    let dbLessonVideos = [];
    let dbTopics = [];
    try {
      const [vRes, tRes] = await Promise.all([
        supabase.from('lesson_videos').select('id, lesson_id, module_id, topic_id, status, hls_master_url, duration_seconds').eq('course_id', course.id),
        supabase.from('topics').select('id, module_id, title, duration_seconds, display_order, start_time_seconds, end_time_seconds, start_timecode, end_timecode, processing_status, hls_master_url, source_video_id, video_asset_id').eq('course_id', course.id).order('display_order', { ascending: true })
      ]);
      dbLessonVideos = vRes.data || [];
      dbTopics = tRes.data || [];
    } catch (dbErr) {
      // topic_id / video_asset_id columns may be absent on older schemas — retry with core columns
      try {
        const [vRes, tRes] = await Promise.all([
          supabase.from('lesson_videos').select('id, lesson_id, module_id, status, hls_master_url, duration_seconds').eq('course_id', course.id),
          supabase.from('topics').select('id, module_id, title, duration_seconds, display_order, start_time_seconds, end_time_seconds, start_timecode, end_timecode, processing_status, hls_master_url, source_video_id').eq('course_id', course.id).order('display_order', { ascending: true })
        ]);
        dbLessonVideos = vRes.data || [];
        dbTopics = tRes.data || [];
      } catch (retryErr) {
        console.warn('⚠️ [Curriculum Read] Notice fetching DB video telemetry:', retryErr.message || dbErr.message);
      }
    }

    const sortModuleFn = (a, b) => {
      const titleA = String(a.title || a.name || '');
      const titleB = String(b.title || b.name || '');
      const numMatchA = titleA.match(/(?:module|mod|m)\s*(\d+)/i) || titleA.match(/^\s*(\d+)/);
      const numMatchB = titleB.match(/(?:module|mod|m)\s*(\d+)/i) || titleB.match(/^\s*(\d+)/);
      const numA = numMatchA ? parseInt(numMatchA[1] || numMatchA[0], 10) : null;
      const numB = numMatchB ? parseInt(numMatchB[1] || numMatchB[0], 10) : null;
      if (numA !== null && numB !== null && numA !== numB) return numA - numB;
      const orderA = a.display_order !== undefined && a.display_order !== null ? Number(a.display_order) : 999;
      const orderB = b.display_order !== undefined && b.display_order !== null ? Number(b.display_order) : 999;
      if (orderA !== orderB) return orderA - orderB;
      return titleA.localeCompare(titleB, undefined, { numeric: true, sensitivity: 'base' });
    };

    // Resolve real topic length from topics + lesson_videos. Never invent a fake default (was 855s = 14m15s).
    // Prefer lesson_videos when present — topics/JSON may still carry the old 855 sentinel.
    const FAKE_TOPIC_DURATION_SECONDS = 855;
    const isSyntheticTopicId = (id) => {
      const s = String(id || '').trim();
      if (!s) return true;
      if (/^(top_|mod_|les_|bm_|topic_\d+)/i.test(s)) return true;
      if (/^\d{1,6}$/.test(s)) return true;
      return false;
    };
    const isUsableDuration = (sec) => {
      const n = Number(sec) || 0;
      return n > 0 && n !== FAKE_TOPIC_DURATION_SECONDS;
    };

    const findLessonVideoDuration = (mt, jsonTopic = null) => {
      if (!mt && !jsonTopic) return 0;
      const topicId = (!isSyntheticTopicId(mt?.id) ? mt?.id : null)
        || (!isSyntheticTopicId(jsonTopic?.id) ? jsonTopic?.id : null)
        || null;
      const sourceVideoId = mt?.source_video_id || mt?.video_asset_id || jsonTopic?.source_video_id || jsonTopic?.video_asset_id || null;
      const hlsUrl = mt?.hls_master_url || jsonTopic?.hls_master_url || null;
      const videos = dbLessonVideos || [];
      const match = videos.find((v) => {
        if (!isUsableDuration(v.duration_seconds)) return false;
        if (topicId && (String(v.topic_id || '') === String(topicId) || String(v.lesson_id || '') === String(topicId))) return true;
        if (sourceVideoId && String(v.id) === String(sourceVideoId)) return true;
        if (hlsUrl && v.hls_master_url && String(v.hls_master_url) === String(hlsUrl)) return true;
        return false;
      });
      return Number(match?.duration_seconds) || 0;
    };

    const resolveTopicDurationSeconds = (mt, jsonTopic = null) => {
      const fromVideo = findLessonVideoDuration(mt, jsonTopic);
      if (fromVideo > 0) return fromVideo;

      const startSec = Number(mt?.start_time_seconds ?? jsonTopic?.start_time_seconds) || 0;
      const endSec = Number(mt?.end_time_seconds ?? jsonTopic?.end_time_seconds) || 0;
      const clipDur = endSec > startSec ? (endSec - startSec) : 0;
      // Mode 1 clips: real boundaries. Ignore clip if it equals the old fake default.
      if (isUsableDuration(clipDur) && (startSec > 0 || endSec > 0)) return clipDur;

      if (isUsableDuration(mt?.duration_seconds)) return Number(mt.duration_seconds);
      if (isUsableDuration(jsonTopic?.duration_seconds)) return Number(jsonTopic.duration_seconds);

      return 0;
    };

    const formatTopicDurationLabel = (durSec) => {
      const sec = Number(durSec) || 0;
      if (sec <= 0 || sec === FAKE_TOPIC_DURATION_SECONDS) return '';
      const mins = Math.floor(sec / 60);
      const remSec = Math.floor(sec % 60);
      if (sec < 60) return `${sec}s`;
      if (mins >= 60) {
        const hrs = Math.floor(mins / 60);
        const remMins = mins % 60;
        return `${hrs}h${remMins ? ` ${remMins}m` : ''}`.trim();
      }
      return remSec > 0 ? `${mins} min ${remSec}s` : `${mins} min`;
    };

    // Helper to format JSON curriculum_modules if present
    const formatJsonCurriculum = (jsonModules) => {
      const sortedJsonModules = [...(jsonModules || [])].sort(sortModuleFn);
      return sortedJsonModules.map((m, idx) => {
        const modIdStr = String(m.id || idx + 1);
        const modNumStr = String(idx + 1);

        const matchedVideos = (dbLessonVideos || []).filter(v => 
          String(v.module_id) === modIdStr || String(v.module_id) === modNumStr || String(v.lesson_id) === modIdStr
        );
        const readyVideo = matchedVideos.find(v => 
          v.status === 'READY' && v.hls_master_url && v.status !== 'FAILED' && v.status !== 'DELETED' && v.status !== 'DELETING' && v.status !== 'UNASSIGNED'
        );
        const uploadedVideo = matchedVideos.find(v => v.status === 'UPLOADED' || v.status === 'SEGMENTATION_REQUIRED' || v.status === 'SEGMENTATION_CONFIRMED');
        const processingVideo = matchedVideos.find(v => v.status === 'PROCESSING' || v.status === 'UPLOADING' || v.status === 'TRANSCODING');

        const hasDbVideo = Boolean(readyVideo || uploadedVideo || processingVideo);
        const isExplicitlyNoVideo = !hasDbVideo && (
          m.video_status === 'NO_VIDEO' || 
          m.video_status === 'UNASSIGNED' || 
          (m.hasVideo === false && !m.video_url && !m.video_asset_id)
        );

        const matchedTopics = isExplicitlyNoVideo ? [] : (dbTopics || []).filter(t => 
          String(t.module_id) === modIdStr || String(t.module_id) === modNumStr
        );
        const readyTopicsWithHls = isExplicitlyNoVideo ? [] : matchedTopics.filter(t => 
          t.processing_status === 'READY' && t.hls_master_url
        );
        const hasRealTopicHls = !isExplicitlyNoVideo && (readyTopicsWithHls.length > 0 || (Array.isArray(m.topics) && m.topics.some(t => Boolean(t?.hls_master_url && t?.processing_status === 'READY'))));

        const effectiveHlsUrl = isExplicitlyNoVideo ? '' : (readyVideo?.hls_master_url || readyTopicsWithHls[0]?.hls_master_url || m.video_url || '');
        const effectiveAssetId = isExplicitlyNoVideo ? null : (readyVideo?.id || uploadedVideo?.id || readyTopicsWithHls[0]?.source_video_id || m.video_asset_id || null);

        // If topics have real duration seconds, calculate total runtime
        const totalTopicSecs = readyTopicsWithHls.reduce((sum, t) => sum + (Number(t.duration_seconds) || 0), 0);
        let durationMins = totalTopicSecs > 0
          ? Math.round(totalTopicSecs / 60)
          : (Number(m.duration_minutes) || (parseFloat(m.duration) ? Math.round(parseFloat(m.duration) * 60) : 60));

        const durationHrsStr = (durationMins / 60) % 1 === 0 ? `${durationMins / 60} hr${durationMins / 60 === 1 ? '' : 's'}` : `${(durationMins / 60).toFixed(1)} hrs`;

        const hasVideoAvailable = !isExplicitlyNoVideo && (Boolean(effectiveHlsUrl && effectiveHlsUrl.trim() !== '') || hasRealTopicHls || Boolean(readyVideo) || Boolean(uploadedVideo));

        const videoStatus = isExplicitlyNoVideo
          ? 'NO_VIDEO'
          : (readyVideo ? 'READY' : (uploadedVideo ? uploadedVideo.status : (processingVideo ? processingVideo.status : (hasVideoAvailable ? 'READY' : (m.video_status || 'NO_VIDEO')))));

        const rawLessons = Array.isArray(m.lessons) ? m.lessons : [];
        const formattedLessons = rawLessons.map((l, lIdx) => {
          if (typeof l === 'object' && l !== null) {
            const rawTopics = Array.isArray(l.topics) ? l.topics : [];
            const formattedTopics = rawTopics.map((t, tIdx) => {
              if (typeof t === 'object' && t !== null) {
                return {
                  id: t.id || `top_${l.id || lIdx + 1}_${tIdx + 1}`,
                  title: t.title || t.name || String(t),
                  hls_master_url: isExplicitlyNoVideo ? null : (t.hls_master_url || null),
                  processing_status: isExplicitlyNoVideo ? 'DRAFT' : (t.processing_status || null),
                  duration_seconds: isExplicitlyNoVideo ? 0 : (t.duration_seconds || 0)
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
              duration_minutes: Number(l.duration_minutes) || 14,
              duration: l.duration || `${Number(l.duration_minutes) || 14} mins`,
              video_url: isExplicitlyNoVideo ? '' : (l.video_url || effectiveHlsUrl),
              video_status: isExplicitlyNoVideo ? 'NO_VIDEO' : (l.video_status || videoStatus),
              thumbnail_url: l.thumbnail_url || course.thumbnail_url || '',
              is_preview: Boolean(l.is_preview || l.is_free_preview),
              is_free_preview: Boolean(l.is_preview || l.is_free_preview),
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
            video_url: isExplicitlyNoVideo ? '' : effectiveHlsUrl,
            video_status: isExplicitlyNoVideo ? 'NO_VIDEO' : videoStatus,
            thumbnail_url: course.thumbnail_url || '',
            is_preview: idx === 0 && lIdx === 0,
            topics: []
          };
        });

        // Merge topic objects with real HLS URLs and status from DB
        const sortTopicFn = (a, b) => {
          const titleA = typeof a === 'object' && a !== null ? (a.title || a.name || '') : String(a || '');
          const titleB = typeof b === 'object' && b !== null ? (b.title || b.name || '') : String(b || '');
          const numMatchA = titleA.match(/(?:topic|lesson|chapter|part)\s*(\d+)/i) || titleA.match(/^\s*(\d+)/);
          const numMatchB = titleB.match(/(?:topic|lesson|chapter|part)\s*(\d+)/i) || titleB.match(/^\s*(\d+)/);
          const numA = numMatchA ? parseInt(numMatchA[1] || numMatchA[0], 10) : null;
          const numB = numMatchB ? parseInt(numMatchB[1] || numMatchB[0], 10) : null;
          if (numA !== null && numB !== null && numA !== numB) return numA - numB;
          const timeA = typeof a?.start_time_seconds === 'number' ? a.start_time_seconds : null;
          const timeB = typeof b?.start_time_seconds === 'number' ? b.start_time_seconds : null;
          if (timeA !== null && timeB !== null && timeA !== timeB && timeA > 0 && timeB > 0) return timeA - timeB;
          const orderA = a.display_order !== undefined && a.display_order !== null ? Number(a.display_order) : 999;
          const orderB = b.display_order !== undefined && b.display_order !== null ? Number(b.display_order) : 999;
          if (orderA !== orderB) return orderA - orderB;
          return titleA.localeCompare(titleB, undefined, { numeric: true, sensitivity: 'base' });
        };

        let mergedTopics = [];
        const baseCurriculumTopics = (Array.isArray(m.topics) && m.topics.length > 0)
          ? m.topics
          : ((Array.isArray(m.lessons) && m.lessons.length > 0) ? m.lessons : []);

        if (baseCurriculumTopics.length > 0) {
          const matchedDbTopicIds = new Set();
          const sortedDbTopics = !isExplicitlyNoVideo && matchedTopics.length > 0
            ? [...matchedTopics].sort(sortTopicFn)
            : [];

          mergedTopics = baseCurriculumTopics.map((t, tIdx) => {
            const isObj = typeof t === 'object' && t !== null;
            const tId = isObj ? t.id : null;
            const tOrder = isObj && t.display_order !== undefined ? Number(t.display_order) : (tIdx + 1);
            const tTitle = isObj ? (t.title || t.name || `Topic ${tIdx + 1}`) : String(t || `Topic ${tIdx + 1}`);

            // Find matching DB topic if available
            let mt = null;
            if (sortedDbTopics.length > 0) {
              if (tId) {
                mt = sortedDbTopics.find(d => String(d.id) === String(tId));
              }
              if (!mt && tOrder !== undefined) {
                mt = sortedDbTopics.find(d => Number(d.display_order) === tOrder);
              }
              if (!mt && tTitle) {
                mt = sortedDbTopics.find(d => {
                  const dTitle = (d.title || '').trim().toLowerCase();
                  return dTitle && dTitle === tTitle.trim().toLowerCase();
                });
              }
              if (!mt && tIdx < sortedDbTopics.length && !matchedDbTopicIds.has(sortedDbTopics[tIdx]?.id)) {
                const candidate = sortedDbTopics[tIdx];
                if (candidate && (!candidate.display_order || Number(candidate.display_order) === tOrder)) {
                  mt = candidate;
                }
              }
            }

            if (mt) {
              matchedDbTopicIds.add(mt.id);
            }

            const effectiveTitle = tTitle || (mt ? mt.title : `Topic ${tIdx + 1}`);
            const durSec = isExplicitlyNoVideo ? 0 : resolveTopicDurationSeconds(mt, isObj ? t : null);
            const durMins = durSec > 0 ? Math.round(durSec / 60) : 0;
            const formattedDur = isExplicitlyNoVideo
              ? '0s'
              : formatTopicDurationLabel(durSec);

            const isTopicPreview = Boolean(
              (isObj && (t.is_preview || t.is_free_preview)) ||
              mt?.is_preview ||
              mt?.is_free_preview
            );

            return {
              // Prefer real DB UUID over synthetic JSON ids like top_1_3
              id: (!isSyntheticTopicId(mt?.id) ? mt.id : null)
                || (!isSyntheticTopicId(tId) ? tId : null)
                || mt?.id
                || tId
                || `top_${modIdStr}_${tIdx + 1}`,
              title: effectiveTitle,
              name: effectiveTitle,
              display_order: tOrder,
              start_time_seconds: isExplicitlyNoVideo ? 0 : (mt?.start_time_seconds ?? (isObj ? (t.start_time_seconds || 0) : 0)),
              end_time_seconds: isExplicitlyNoVideo ? 0 : (mt?.end_time_seconds ?? (isObj ? (t.end_time_seconds || 0) : 0)),
              start_timecode: isExplicitlyNoVideo ? '' : (mt?.start_timecode || (isObj ? (t.start_timecode || '') : '')),
              end_timecode: isExplicitlyNoVideo ? '' : (mt?.end_timecode || (isObj ? (t.end_timecode || '') : '')),
              duration_seconds: isExplicitlyNoVideo ? 0 : durSec,
              duration: isExplicitlyNoVideo ? '0s' : formattedDur,
              duration_minutes: isExplicitlyNoVideo ? 0 : durMins,
              processing_status: isExplicitlyNoVideo ? 'DRAFT' : (mt?.processing_status || (isObj ? t.processing_status : null) || 'DRAFT'),
              hls_master_url: isExplicitlyNoVideo ? null : (mt?.hls_master_url || (isObj ? t.hls_master_url : null) || null),
              source_video_id: isExplicitlyNoVideo ? null : (mt?.source_video_id || (isObj ? t.source_video_id : null) || null),
              video_asset_id: isExplicitlyNoVideo ? null : (mt?.video_asset_id || mt?.source_video_id || (isObj ? (t.video_asset_id || t.source_video_id) : null) || null),
              is_preview: isTopicPreview,
              is_free_preview: isTopicPreview
            };
          });

          // Append any DB topics that weren't in base curriculum
          if (sortedDbTopics.length > 0) {
            for (let dbIdx = 0; dbIdx < sortedDbTopics.length; dbIdx++) {
              const mt = sortedDbTopics[dbIdx];
              if (mt && mt.id && !matchedDbTopicIds.has(mt.id)) {
                const durSec = isExplicitlyNoVideo ? 0 : resolveTopicDurationSeconds(mt);
                const durMins = durSec > 0 ? Math.round(durSec / 60) : 0;
                const formattedDur = isExplicitlyNoVideo ? '0s' : formatTopicDurationLabel(durSec);
                const isTopicPreview = Boolean(mt.is_preview || mt.is_free_preview);

                mergedTopics.push({
                  id: mt.id || `top_${modIdStr}_db_${dbIdx + 1}`,
                  title: mt.title || `Topic ${mergedTopics.length + 1}`,
                  name: mt.title || `Topic ${mergedTopics.length + 1}`,
                  display_order: mt.display_order !== undefined ? mt.display_order : (mergedTopics.length + 1),
                  start_time_seconds: isExplicitlyNoVideo ? 0 : (mt.start_time_seconds || 0),
                  end_time_seconds: isExplicitlyNoVideo ? 0 : (mt.end_time_seconds || 0),
                  start_timecode: isExplicitlyNoVideo ? '' : (mt.start_timecode || ''),
                  end_timecode: isExplicitlyNoVideo ? '' : (mt.end_timecode || ''),
                  duration_seconds: isExplicitlyNoVideo ? 0 : durSec,
                  duration: isExplicitlyNoVideo ? '0s' : formattedDur,
                  duration_minutes: isExplicitlyNoVideo ? 0 : durMins,
                  processing_status: isExplicitlyNoVideo ? 'DRAFT' : (mt.processing_status || 'DRAFT'),
                  hls_master_url: isExplicitlyNoVideo ? null : (mt.hls_master_url || null),
                  is_preview: isTopicPreview,
                  is_free_preview: isTopicPreview
                });
              }
            }
          }
        } else if (!isExplicitlyNoVideo && matchedTopics.length > 0) {
          const sortedDbTopics = [...matchedTopics].sort(sortTopicFn);
          mergedTopics = sortedDbTopics.map((mt, mtIdx) => {
            const durSec = resolveTopicDurationSeconds(mt);
            const durMins = durSec > 0 ? Math.round(durSec / 60) : 0;
            const formattedDur = formatTopicDurationLabel(durSec);
            const isTopicPreview = Boolean(mt.is_preview || mt.is_free_preview);

            return {
              id: mt.id || `top_${modIdStr}_${mtIdx + 1}`,
              title: mt.title || `Topic ${mtIdx + 1}`,
              name: mt.title || `Topic ${mtIdx + 1}`,
              display_order: mt.display_order !== undefined ? mt.display_order : mtIdx + 1,
              start_time_seconds: mt.start_time_seconds || 0,
              end_time_seconds: mt.end_time_seconds || 0,
              start_timecode: mt.start_timecode || '',
              end_timecode: mt.end_timecode || '',
              duration_seconds: durSec,
              duration: formattedDur,
              duration_minutes: durMins,
              processing_status: mt.processing_status || 'DRAFT',
              hls_master_url: mt.hls_master_url || null,
              is_preview: isTopicPreview,
              is_free_preview: isTopicPreview
            };
          });
        } else {
          mergedTopics = formattedLessons.map((l, lIdx) => ({ id: l.id, title: l.title, display_order: lIdx + 1 }));
        }
        mergedTopics.sort(sortTopicFn);

        const videoCount = isExplicitlyNoVideo ? 0 : (formattedLessons.filter(l => l.lesson_type === 'VIDEO' && l.video_url).length || (hasVideoAvailable ? 1 : 0));

        return {
          id: m.id || `mod_${idx + 1}`,
          course_id: course.id,
          courseId: course.id,
          course_slug: course.slug,
          courseSlug: course.slug,
          name: m.title || m.name || `Module ${idx + 1}`,
          title: m.title || m.name || `Module ${idx + 1}`,
          description: m.description || `Module ${idx + 1} of ${course.title}`,
          display_order: m.display_order || idx + 1,
          duration: m.duration || durationHrsStr,
          duration_minutes: durationMins,
          duration_hours: m.duration_hours || Math.round((durationMins / 60) * 10) / 10,
          video_url: isExplicitlyNoVideo ? '' : effectiveHlsUrl,
          video_status: isExplicitlyNoVideo ? 'NO_VIDEO' : videoStatus,
          hasVideo: !isExplicitlyNoVideo && hasVideoAvailable,
          video_title: m.video_title || m.title || m.name,
          video_asset_id: isExplicitlyNoVideo ? null : effectiveAssetId,
          video_error_message: isExplicitlyNoVideo ? '' : (m.video_error_message || ''),
          topics: mergedTopics,
          videos: videoCount,
          is_preview: Boolean(m.is_preview || m.is_free_preview),
          is_free_preview: Boolean(m.is_preview || m.is_free_preview),
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

        formattedModules = (await Promise.all(modulePromises)).sort(sortModuleFn);
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
