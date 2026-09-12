const { supabase } = require('../../config/supabase');
const { generateSlug } = require('../../utils/slug');
const departmentService = require('../departments/department.service');

let courseCatalogCache = { data: null, timestamp: 0 };
const COURSE_CACHE_TTL_MS = 60000; // 60s TTL

function clearCourseCache() {
  courseCatalogCache = { data: null, timestamp: 0 };
}

class CourseService {
  clearCache() {
    clearCourseCache();
  }

  /**
   * Fetch lightweight courses catalog list (excludes heavy curriculum_modules JSONB)
   */
  async getCourses(isAdmin = false) {
    const now = Date.now();
    if (!isAdmin && courseCatalogCache.data && (now - courseCatalogCache.timestamp < COURSE_CACHE_TTL_MS)) {
      return courseCatalogCache.data;
    }

    let query = supabase
      .from('courses')
      .select('id, category_id, title, slug, short_description, description, image_url, duration, level, instructor_name, skills, price, installment_price, status, created_at, updated_at, curriculum_modules')
      .order('title', { ascending: true });

    if (!isAdmin) {
      query = query.in('status', ['PUBLISHED', 'ACTIVE']);
    }

    const [{ data, error }, { data: pricingRows }, depts] = await Promise.all([
      query,
      supabase.from('course_pricing').select('course_id, sale_price, full_payment_amount, installment_1_price').eq('is_active', true),
      departmentService.getAllDepartments(true).catch(() => [])
    ]);

    if (error) throw error;

    let deptMap = new Map();
    if (Array.isArray(depts)) {
      depts.forEach(d => deptMap.set(d.id, d));
    }

    let pricingMap = new Map();
    if (Array.isArray(pricingRows)) {
      pricingRows.forEach(p => {
        if (p.course_id) pricingMap.set(String(p.course_id), p);
      });
    }

    const result = (data || []).map((c, index) => {
      const deptId = c.category_id || null;
      const deptObj = deptId ? deptMap.get(deptId) : null;
      const deptName = deptObj ? deptObj.name : '';
      const deptSlug = deptObj ? deptObj.slug : '';

      const pr = pricingMap.get(String(c.id));
      const resolvedPrice = Number(pr?.sale_price || pr?.full_payment_amount || c.price || 4000);
      const resolvedInstallmentPrice = Number(pr?.installment_1_price || c.installment_price || 1500);

      const curriculumMods = Array.isArray(c.curriculum_modules)
        ? c.curriculum_modules
        : (typeof c.curriculum_modules === 'string'
          ? (() => { try { return JSON.parse(c.curriculum_modules); } catch { return []; } })()
          : []);

      return {
        id: c.id,
        department_id: deptId,
        department_name: deptName,
        department_slug: deptSlug,
        department: deptObj ? { id: deptObj.id, name: deptObj.name, slug: deptObj.slug } : null,
        category: deptName,
        title: c.title,
        slug: c.slug,
        short_description: c.short_description || '',
        description: c.description || '',
        thumbnail_url: c.image_url || c.thumbnail_url || '',
        image_url: c.image_url || c.thumbnail_url || '',
        duration: c.duration || '8 Weeks',
        level: c.level || 'Beginner to Advanced',
        instructor_name: c.instructor_name || 'InternNetra Industry Expert',
        skills: Array.isArray(c.skills) ? c.skills : [],
        price: resolvedPrice,
        installment_price: resolvedInstallmentPrice,
        rating: c.rating !== undefined ? c.rating : null,
        students: c.students || '',
        display_order: c.display_order !== undefined ? c.display_order : index + 1,
        status: (c.status || 'PUBLISHED').toUpperCase(),
        curriculum_modules: curriculumMods,
        modules: curriculumMods,
        modulesCount: curriculumMods.length,
        created_at: c.created_at,
        updated_at: c.updated_at
      };
    });

    if (!isAdmin) {
      courseCatalogCache = { data: result, timestamp: now };
    }

    return result;
  }

  /**
   * Helper to resolve department details for single course
   */
  async resolveDepartmentInfo(departmentId) {
    if (!departmentId) return { department_name: '', department_slug: '', department: null };
    try {
      const deptObj = await departmentService.getDepartmentById(departmentId);
      if (deptObj) {
        return {
          department_name: deptObj.name,
          department_slug: deptObj.slug,
          department: {
            id: deptObj.id,
            name: deptObj.name,
            slug: deptObj.slug
          }
        };
      }
    } catch (err) {
      console.warn("Department lookup note:", err.message || err);
    }
    return { department_name: '', department_slug: '', department: null };
  }

  /**
   * Fetch single course by slug
   */
  async getCourseBySlug(slug, isAdmin = false) {
    if (!slug) return null;

    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
    if (isUUID) {
      const courseById = await this.getCourseById(slug, isAdmin);
      if (courseById) return courseById;
    }

    const cleanSlug = String(slug).toLowerCase().trim();
    let query = supabase
      .from('courses')
      .select('*')
      .eq('slug', cleanSlug);

    if (!isAdmin) {
      query = query.in('status', ['PUBLISHED', 'ACTIVE']);
    }

    const { data, error } = await query.limit(1);
    if (error) throw error;
    let course = data?.[0] || null;

    // Fallback 1: Try stripping common department prefixes (e.g., 'cse-it-', 'ece-eee-', 'mech-civil-', 'management-')
    if (!course) {
      const strippedSlug = cleanSlug.replace(/^(cse-it|ece-eee|mech-civil|management|add-on-programs)-/, '');
      if (strippedSlug && strippedSlug !== cleanSlug) {
        let fallbackQuery = supabase
          .from('courses')
          .select('*')
          .eq('slug', strippedSlug);
        if (!isAdmin) fallbackQuery = fallbackQuery.in('status', ['PUBLISHED', 'ACTIVE']);
        const { data: fbData } = await fallbackQuery.limit(1);
        if (fbData?.[0]) course = fbData[0];
      }
    }

    // Fallback 2: Match by generated slug from title
    if (!course) {
      const { data: allCourses } = await supabase.from('courses').select('*');
      if (Array.isArray(allCourses)) {
        course = allCourses.find(c => {
          const gen = generateSlug(c.title);
          return gen === cleanSlug || gen === cleanSlug.replace(/^(cse-it|ece-eee|mech-civil|management|add-on-programs)-/, '');
        });
      }
    }

    if (!course) return null;

    const deptId = course.category_id || null;
    const deptInfo = await this.resolveDepartmentInfo(deptId);

    return {
      id: course.id,
      department_id: deptId,
      department_name: deptInfo.department_name,
      department_slug: deptInfo.department_slug,
      department: deptInfo.department,
      category: deptInfo.department_name,
      title: course.title,
      slug: course.slug,
      short_description: course.short_description || '',
      description: course.description || '',
      thumbnail_url: course.image_url || course.thumbnail_url || '',
      image_url: course.image_url || course.thumbnail_url || '',
      duration: course.duration || '8 Weeks',
      level: course.level || 'Beginner to Advanced',
      instructor_name: course.instructor_name || 'InternNetra Industry Expert',
      instructor_role: course.instructor_role || '',
      instructor_bio: course.instructor_bio || '',
      skills: Array.isArray(course.skills) ? course.skills : [],
      learning_outcomes: Array.isArray(course.learning_outcomes) ? course.learning_outcomes : (typeof course.learning_outcomes === 'string' ? (()=>{ try{ return JSON.parse(course.learning_outcomes); }catch{ return []; } })() : []),
      course_includes: Array.isArray(course.course_includes) ? course.course_includes : (typeof course.course_includes === 'string' ? (()=>{ try{ return JSON.parse(course.course_includes); }catch{ return []; } })() : []),
      prerequisites: Array.isArray(course.prerequisites) ? course.prerequisites : (typeof course.prerequisites === 'string' ? (()=>{ try{ return JSON.parse(course.prerequisites); }catch{ return []; } })() : []),
      target_audience: Array.isArray(course.target_audience) ? course.target_audience : (typeof course.target_audience === 'string' ? (()=>{ try{ return JSON.parse(course.target_audience); }catch{ return []; } })() : []),
      curriculum_modules: Array.isArray(course.curriculum_modules) ? course.curriculum_modules : [],
      price: Number(course.price || 4000),
      installment_price: Number(course.installment_price || 1500),
      display_order: course.display_order !== undefined ? course.display_order : 1,
      status: (course.status || 'PUBLISHED').toUpperCase(),
      created_at: course.created_at,
      updated_at: course.updated_at
    };
  }

  /**
   * Fetch single course by ID
   */
  async getCourseById(id, isAdmin = false) {
    if (!id) return null;
    let query = supabase
      .from('courses')
      .select('*')
      .eq('id', id);

    if (!isAdmin) {
      query = query.in('status', ['PUBLISHED', 'ACTIVE']);
    }

    const { data, error } = await query.maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const deptId = data.category_id || null;
    const deptInfo = await this.resolveDepartmentInfo(deptId);

    return {
      id: data.id,
      department_id: deptId,
      department_name: deptInfo.department_name,
      department_slug: deptInfo.department_slug,
      department: deptInfo.department,
      category: deptInfo.department_name,
      title: data.title,
      slug: data.slug,
      short_description: data.short_description || '',
      description: data.description || '',
      thumbnail_url: data.thumbnail_url || data.image_url || '',
      image_url: data.thumbnail_url || data.image_url || '',
      duration: data.duration || '8 Weeks',
      level: data.level || 'Beginner to Advanced',
      instructor_name: data.instructor_name || 'InternNetra Industry Expert',
      instructor_role: data.instructor_role || '',
      instructor_bio: data.instructor_bio || '',
      skills: Array.isArray(data.skills) ? data.skills : [],
      learning_outcomes: Array.isArray(data.learning_outcomes) ? data.learning_outcomes : (typeof data.learning_outcomes === 'string' ? (()=>{ try{ return JSON.parse(data.learning_outcomes); }catch{ return []; } })() : []),
      course_includes: Array.isArray(data.course_includes) ? data.course_includes : (typeof data.course_includes === 'string' ? (()=>{ try{ return JSON.parse(data.course_includes); }catch{ return []; } })() : []),
      prerequisites: Array.isArray(data.prerequisites) ? data.prerequisites : (typeof data.prerequisites === 'string' ? (()=>{ try{ return JSON.parse(data.prerequisites); }catch{ return []; } })() : []),
      target_audience: Array.isArray(data.target_audience) ? data.target_audience : (typeof data.target_audience === 'string' ? (()=>{ try{ return JSON.parse(data.target_audience); }catch{ return []; } })() : []),
      curriculum_modules: Array.isArray(data.curriculum_modules) ? data.curriculum_modules : [],
      price: Number(data.price || 4000),
      installment_price: Number(data.installment_price || 1500),
      display_order: data.display_order !== undefined ? data.display_order : 1,
      status: (data.status || 'PUBLISHED').toUpperCase(),
      created_at: data.created_at,
      updated_at: data.updated_at
    };
  }

  /**
   * Fetch single course by Identifier (UUID or Slug fallback)
   */
  async getCourseByIdentifier(identifier, isAdmin = false) {
    if (!identifier) return null;
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    if (isUUID) {
      const byId = await this.getCourseById(identifier, isAdmin);
      if (byId) return byId;
    }
    return this.getCourseBySlug(identifier, isAdmin);
  }

  /**
   * Create course
   */
  async createCourse(data) {
    // 1. Verify referenced department exists
    const deptId = data.department_id || data.category_id;
    const dept = await departmentService.getDepartmentById(deptId);
    if (!dept) {
      throw { statusCode: 400, message: `Referenced department_id '${deptId}' does not exist.` };
    }

    // 2. Generate and check slug
    let slug = data.slug || generateSlug(data.title);
    if (!slug) {
      throw { statusCode: 400, message: 'Unable to generate valid slug from course title.' };
    }

    const existingSlug = await this.getCourseBySlug(slug, true);
    if (existingSlug) {
      throw { statusCode: 409, message: `Course with slug '${slug}' already exists.` };
    }

    const insertPayload = {
      category_id: deptId,
      title: data.title,
      slug,
      short_description: data.short_description || '',
      description: data.description || '',
      image_url: data.thumbnail_url !== undefined ? data.thumbnail_url : (data.image_url || ''),
      duration: data.duration || '8 Weeks',
      level: data.level || 'Beginner to Advanced',
      instructor_name: data.instructor_name || 'Industry Expert',
      instructor_role: data.instructor_role || 'Senior Technical Mentor',
      instructor_bio: data.instructor_bio || '',
      skills: Array.isArray(data.skills) ? data.skills : [],
      learning_outcomes: Array.isArray(data.learning_outcomes) ? data.learning_outcomes : [],
      course_includes: Array.isArray(data.course_includes) ? data.course_includes : [],
      prerequisites: Array.isArray(data.prerequisites) ? data.prerequisites : [],
      target_audience: Array.isArray(data.target_audience) ? data.target_audience : [],
      status: (data.status || 'PUBLISHED').toUpperCase(),
      curriculum_modules: Array.isArray(data.curriculum_modules) ? data.curriculum_modules : []
    };

    const { data: newCourse, error } = await supabase
      .from('courses')
      .insert([insertPayload])
      .select()
      .single();

    if (error) throw error;
    clearCourseCache();

    return {
      id: newCourse.id,
      department_id: newCourse.category_id || data.department_id,
      title: newCourse.title,
      slug: newCourse.slug,
      short_description: newCourse.short_description || '',
      description: newCourse.description || '',
      thumbnail_url: newCourse.image_url || newCourse.thumbnail_url || '',
      image_url: newCourse.image_url || newCourse.thumbnail_url || '',
      duration: newCourse.duration || '8 Weeks',
      level: newCourse.level || 'Beginner to Advanced',
      instructor_name: newCourse.instructor_name || 'Industry Expert',
      instructor_role: newCourse.instructor_role || '',
      instructor_bio: newCourse.instructor_bio || '',
      skills: Array.isArray(newCourse.skills) ? newCourse.skills : [],
      learning_outcomes: Array.isArray(newCourse.learning_outcomes) ? newCourse.learning_outcomes : [],
      course_includes: Array.isArray(newCourse.course_includes) ? newCourse.course_includes : [],
      prerequisites: Array.isArray(newCourse.prerequisites) ? newCourse.prerequisites : [],
      target_audience: Array.isArray(newCourse.target_audience) ? newCourse.target_audience : [],
      curriculum_modules: Array.isArray(newCourse.curriculum_modules) ? newCourse.curriculum_modules : [],
      display_order: newCourse.display_order !== undefined ? newCourse.display_order : 0,
      status: (newCourse.status || 'PUBLISHED').toUpperCase(),
      created_at: newCourse.created_at,
      updated_at: newCourse.updated_at
    };
  }

  /**
   * Update course
   */
  async updateCourse(id, updateData) {
    const existing = await this.getCourseById(id, true);
    if (!existing) {
      throw { statusCode: 404, message: 'Course not found.' };
    }

    if (updateData.department_id && updateData.department_id !== existing.department_id) {
      const dept = await departmentService.getDepartmentById(updateData.department_id);
      if (!dept) {
        throw { statusCode: 400, message: `Referenced department_id '${updateData.department_id}' does not exist.` };
      }
    }

    if (updateData.slug && updateData.slug !== existing.slug) {
      const slugMatch = await this.getCourseBySlug(updateData.slug, true);
      if (slugMatch && slugMatch.id !== id) {
        throw { statusCode: 409, message: `Course with slug '${updateData.slug}' already exists.` };
      }
    }

    // Whitelist only valid database columns to prevent PostgREST rejecting extra frontend form properties
    const payload = {
      updated_at: new Date().toISOString()
    };

    if (updateData.title !== undefined) payload.title = updateData.title;
    if (updateData.slug !== undefined) payload.slug = updateData.slug;
    if (updateData.short_description !== undefined) payload.short_description = updateData.short_description;
    if (updateData.description !== undefined) payload.description = updateData.description;
    if (updateData.duration !== undefined) payload.duration = updateData.duration;
    if (updateData.level !== undefined) payload.level = updateData.level;
    if (updateData.instructor_name !== undefined) payload.instructor_name = updateData.instructor_name;
    if (updateData.instructor_role !== undefined) payload.instructor_role = updateData.instructor_role;
    if (updateData.instructor_bio !== undefined) payload.instructor_bio = updateData.instructor_bio;
    if (updateData.skills !== undefined) payload.skills = Array.isArray(updateData.skills) ? updateData.skills : [];
    if (updateData.learning_outcomes !== undefined) payload.learning_outcomes = Array.isArray(updateData.learning_outcomes) ? updateData.learning_outcomes : [];
    if (updateData.course_includes !== undefined) payload.course_includes = Array.isArray(updateData.course_includes) ? updateData.course_includes : [];
    if (updateData.prerequisites !== undefined) payload.prerequisites = Array.isArray(updateData.prerequisites) ? updateData.prerequisites : [];
    if (updateData.target_audience !== undefined) payload.target_audience = Array.isArray(updateData.target_audience) ? updateData.target_audience : [];
    if (updateData.curriculum_modules !== undefined) payload.curriculum_modules = Array.isArray(updateData.curriculum_modules) ? updateData.curriculum_modules : [];
    if (updateData.status !== undefined) payload.status = updateData.status.toUpperCase();

    if (updateData.department_id) {
      payload.category_id = updateData.department_id;
    } else if (updateData.category_id) {
      payload.category_id = updateData.category_id;
    }

    const thumbValue = updateData.thumbnail_url !== undefined ? updateData.thumbnail_url : updateData.image_url;
    if (thumbValue !== undefined) {
      payload.image_url = thumbValue;
    }

    const { data: updated, error } = await supabase
      .from('courses')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    clearCourseCache();

    return {
      id: updated.id,
      department_id: updated.category_id || existing.department_id,
      title: updated.title,
      slug: updated.slug,
      short_description: updated.short_description || '',
      description: updated.description || '',
      thumbnail_url: updated.image_url || updated.thumbnail_url || '',
      image_url: updated.image_url || updated.thumbnail_url || '',
      duration: updated.duration || existing.duration || '8 Weeks',
      level: updated.level || existing.level || 'Beginner to Advanced',
      instructor_name: updated.instructor_name || existing.instructor_name || 'Industry Expert',
      instructor_role: updated.instructor_role || existing.instructor_role || '',
      instructor_bio: updated.instructor_bio || existing.instructor_bio || '',
      skills: Array.isArray(updated.skills) ? updated.skills : [],
      learning_outcomes: Array.isArray(updated.learning_outcomes) ? updated.learning_outcomes : [],
      course_includes: Array.isArray(updated.course_includes) ? updated.course_includes : [],
      prerequisites: Array.isArray(updated.prerequisites) ? updated.prerequisites : [],
      target_audience: Array.isArray(updated.target_audience) ? updated.target_audience : [],
      curriculum_modules: Array.isArray(updated.curriculum_modules) ? updated.curriculum_modules : [],
      status: (updated.status || 'PUBLISHED').toUpperCase(),
      created_at: updated.created_at,
      updated_at: updated.updated_at
    };
  }

  /**
   * Update course status
   */
  async updateCourseStatus(id, status) {
    return this.updateCourse(id, { status });
  }

  /**
   * Delete course (Hierarchical Deletion Policy: prevents deletion if modules exist unless cascade=true)
   */
  async deleteCourse(id, cascade = false) {
    if (!id) throw { statusCode: 400, message: 'Course ID is required.' };

    // 1. Fetch exact course row from Supabase
    let { data: courseRow } = await supabase
      .from('courses')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (!courseRow) {
      const { data: courseBySlug } = await supabase
        .from('courses')
        .select('*')
        .eq('slug', String(id).toLowerCase())
        .maybeSingle();
      if (courseBySlug) {
        courseRow = courseBySlug;
      }
    }

    if (!courseRow) {
      throw { statusCode: 404, message: 'Course not found.' };
    }

    // 2. Hierarchy Check: Course MUST NOT be deleted if it currently contains 1 or more modules (unless cascade=true)
    const modules = Array.isArray(courseRow.curriculum_modules) ? courseRow.curriculum_modules : [];
    if (modules.length > 0 && !cascade) {
      console.log(`[COURSE DELETE CHECK] Course '${id}' contains ${modules.length} modules. Rejection triggered.`);
      throw {
        statusCode: 422,
        code: 'COURSE_HAS_MODULES',
        message: 'Cannot delete course because it contains modules.',
        details: {
          course_id: id,
          module_count: modules.length
        }
      };
    }

    console.log(`[COURSE DELETE CHECK] Course '${id}' deletion allowed (modules: ${modules.length}, cascade: ${cascade}).`);

    // 3. Clean up any associated orphan records (versions, enrollments, pricing configs, coupons)
    try {
      await supabase.from('course_versions').delete().eq('course_id', courseRow.id);
    } catch (e) {
      console.warn("Course versions cleanup note:", e.message || e);
    }
    try {
      await supabase.from('enrollments').delete().eq('course_id', courseRow.id);
    } catch (e) {
      console.warn("Enrollments cleanup note:", e.message || e);
    }
    try {
      await supabase.from('course_pricing').delete().eq('course_id', courseRow.id);
    } catch (e) {
      console.warn("Course pricing cleanup note:", e.message || e);
    }
    try {
      await supabase.from('coupons').delete().eq('course_id', courseRow.id);
    } catch (e) {
      console.warn("Coupons cleanup note:", e.message || e);
    }

    // 4. Perform course deletion
    const { error: deleteErr } = await supabase
      .from('courses')
      .delete()
      .eq('id', courseRow.id);

    if (deleteErr) throw deleteErr;
    clearCourseCache();
    return true;
  }

  /**
   * Batches (Backwards Compatibility)
   */
  async getBatches() {
    const { data: batches, error } = await supabase
      .from('batches')
      .select('id, course_id, batch_name, batch_code, start_date, schedule, mode, capacity, enrolled_count, status')
      .neq('status', 'CLOSED')
      .order('start_date', { ascending: true });

    if (error) throw error;
    return batches || [];
  }

  async createBatch({ batchName, courseId, startDate, capacity = 50 }) {
    const batchCode = `BATCH_${Date.now().toString().slice(-6)}`;
    const { data: newBatch, error } = await supabase.from('batches').insert([{
      course_id: courseId,
      batch_name: batchName,
      batch_code: batchCode,
      start_date: startDate || new Date().toISOString().split('T')[0],
      capacity,
      enrolled_count: 0,
      status: 'ACTIVE'
    }]).select().single();

    if (error) throw error;
    return newBatch;
  }

  /**
   * Fetch live academic dashboard statistics (with in-memory cache)
   */
  async getAcademicStats() {
    if (this._academicStatsCache && (Date.now() - (this._academicStatsCacheTime || 0) < 60000)) {
      return this._academicStatsCache;
    }

    try {
      const { count: deptCount } = await supabase.from('categories').select('*', { count: 'exact', head: true });
      const { data: courses } = await supabase.from('courses').select('id, status, curriculum_modules');
      const { count: pricingCount } = await supabase.from('course_pricing').select('*', { count: 'exact', head: true }).eq('is_active', true);

      let totalModules = 0;
      let totalTopics = 0;
      let activeCourses = 0;
      let draftCourses = 0;

      (courses || []).forEach(c => {
        const status = (c.status || '').toUpperCase();
        if (['PUBLISHED', 'ACTIVE'].includes(status)) activeCourses++;
        else draftCourses++;

        const mods = Array.isArray(c.curriculum_modules) ? c.curriculum_modules : [];
        totalModules += mods.length;
        mods.forEach(m => {
          const lessons = Array.isArray(m.lessons) ? m.lessons : (Array.isArray(m.topics) ? m.topics : []);
          totalTopics += lessons.length;
        });
      });

      const stats = {
        totalDepartments: deptCount || 0,
        totalCourses: (courses || []).length,
        totalModules,
        totalTopics,
        activeCourses,
        draftCourses,
        activePricingPlans: pricingCount || ((courses || []).length * 2)
      };

      this._academicStatsCache = stats;
      this._academicStatsCacheTime = Date.now();
      return stats;
    } catch (err) {
      if (this._academicStatsCache) return this._academicStatsCache;
      throw err;
    }
  }
}

module.exports = new CourseService();
