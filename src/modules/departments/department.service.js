const { supabase } = require('../../config/supabase');
const { generateSlug } = require('../../utils/slug');

function extractDeptThumb(d) {
  if (!d) return '';
  if (d.thumbnail_url && typeof d.thumbnail_url === 'string' && d.thumbnail_url.trim()) return d.thumbnail_url.trim();
  if (d.image_url && typeof d.image_url === 'string' && d.image_url.trim() && d.image_url !== 'Folder') return d.image_url.trim();
  if (d.icon && typeof d.icon === 'string' && d.icon.trim() && d.icon !== 'Folder') return d.icon.trim();
  return '';
}

let departmentCache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 60000; // 60s TTL

function clearDepartmentCache() {
  departmentCache = { data: null, timestamp: 0 };
}

class DepartmentService {
  clearCache() {
    clearDepartmentCache();
  }

  /**
   * Helper to detect available table name (departments vs categories fallback)
   */
  async getTableName() {
    const { error } = await supabase.from('departments').select('id').limit(1);
    if (error && error.code === 'PGRST205') {
      return 'categories';
    }
    return 'departments';
  }

  /**
   * Fetch list of departments (cached with course counts)
   */
  async getAllDepartments(includeAll = false) {
    const now = Date.now();
    if (!includeAll && departmentCache.data && (now - departmentCache.timestamp < CACHE_TTL_MS)) {
      return departmentCache.data;
    }

    const table = await this.getTableName();
    let query = supabase
      .from(table)
      .select('*')
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });

    if (!includeAll) {
      query = query.ilike('status', 'active');
    }

    const [deptRes, coursesRes] = await Promise.all([
      query,
      supabase.from('courses').select('id, category_id').in('status', ['PUBLISHED', 'ACTIVE', 'published', 'active'])
    ]);

    if (deptRes.error) throw deptRes.error;

    const coursesList = coursesRes.data || [];
    const countsMap = new Map();
    coursesList.forEach(c => {
      const dId = c.category_id;
      if (dId) {
        countsMap.set(String(dId), (countsMap.get(String(dId)) || 0) + 1);
      }
    });

    const result = (deptRes.data || []).map(d => {
      const thumb = extractDeptThumb(d);
      const cCount = countsMap.get(String(d.id)) || 0;
      return {
        id: d.id,
        name: d.name,
        slug: d.slug,
        description: d.description || '',
        thumbnail_url: thumb,
        image_url: thumb,
        display_order: d.display_order || 0,
        status: (d.status || 'ACTIVE').toUpperCase(),
        courses_count: cCount,
        coursesCount: cCount,
        created_at: d.created_at,
        updated_at: d.updated_at
      };
    });

    if (!includeAll) {
      departmentCache = { data: result, timestamp: now };
    }

    return result;
  }

  /**
   * Fetch single department by slug
   */
  async getDepartmentBySlug(slug) {
    if (!slug) return null;
    const table = await this.getTableName();
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('slug', slug.toLowerCase())
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const thumb = extractDeptThumb(data);
    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      description: data.description || '',
      thumbnail_url: thumb,
      image_url: thumb,
      display_order: data.display_order || 0,
      status: (data.status || 'ACTIVE').toUpperCase(),
      created_at: data.created_at,
      updated_at: data.updated_at
    };
  }

  /**
   * Fetch single department by ID
   */
  async getDepartmentById(id) {
    if (!id) return null;
    const table = await this.getTableName();
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const thumb = extractDeptThumb(data);
    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      description: data.description || '',
      thumbnail_url: thumb,
      image_url: thumb,
      display_order: data.display_order || 0,
      status: (data.status || 'ACTIVE').toUpperCase(),
      created_at: data.created_at,
      updated_at: data.updated_at
    };
  }

  /**
   * Fetch single department by Identifier (UUID or Slug fallback)
   */
  async getDepartmentByIdentifier(identifier) {
    if (!identifier) return null;
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    if (isUUID) {
      return this.getDepartmentById(identifier);
    }
    return this.getDepartmentBySlug(identifier);
  }

  /**
   * Create a new department
   */
  async createDepartment(data) {
    const table = await this.getTableName();
    let slug = data.slug || generateSlug(data.name);

    if (!slug) {
      throw { statusCode: 400, message: 'Unable to generate valid slug from department name.' };
    }

    const existing = await this.getDepartmentBySlug(slug);
    if (existing) {
      throw { statusCode: 409, message: `Department with slug '${slug}' already exists.` };
    }

    const thumbValue = data.thumbnail_url !== undefined ? data.thumbnail_url : (data.image_url || '');

    const insertPayload = {
      name: data.name,
      slug,
      description: data.description || '',
      display_order: data.display_order !== undefined ? data.display_order : 0,
      status: (data.status || 'ACTIVE').toLowerCase()
    };

    if (table === 'departments') {
      insertPayload.thumbnail_url = thumbValue;
      insertPayload.image_url = thumbValue;
    } else {
      insertPayload.icon = thumbValue || 'Folder';
    }

    const { data: newDept, error } = await supabase
      .from(table)
      .insert([insertPayload])
      .select()
      .single();

    if (error) throw error;
    clearDepartmentCache();

    const thumb = extractDeptThumb(newDept);
    return {
      id: newDept.id,
      name: newDept.name,
      slug: newDept.slug,
      description: newDept.description || '',
      thumbnail_url: thumb,
      image_url: thumb,
      display_order: newDept.display_order || 0,
      status: (newDept.status || 'ACTIVE').toUpperCase(),
      created_at: newDept.created_at,
      updated_at: newDept.updated_at
    };
  }

  /**
   * Update department details
   */
  async updateDepartment(id, updateData) {
    const table = await this.getTableName();
    const existing = await this.getDepartmentById(id);
    if (!existing) {
      throw { statusCode: 404, message: 'Department not found.' };
    }

    if (updateData.slug && updateData.slug !== existing.slug) {
      const slugMatch = await this.getDepartmentBySlug(updateData.slug);
      if (slugMatch && slugMatch.id !== id) {
        throw { statusCode: 409, message: `Department with slug '${updateData.slug}' already exists.` };
      }
    }

    const payload = { ...updateData, updated_at: new Date().toISOString() };
    if (payload.status) payload.status = payload.status.toLowerCase();

    delete payload.thumbnail_url;
    delete payload.image_url;

    const thumbValue = updateData.thumbnail_url !== undefined ? updateData.thumbnail_url : updateData.image_url;
    if (thumbValue !== undefined) {
      if (table === 'departments') {
        payload.thumbnail_url = thumbValue;
        payload.image_url = thumbValue;
      } else {
        payload.icon = thumbValue;
      }
    }

    const { data: updated, error } = await supabase
      .from(table)
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    clearDepartmentCache();

    const thumb = extractDeptThumb(updated);
    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      description: updated.description || '',
      thumbnail_url: thumb,
      image_url: thumb,
      display_order: updated.display_order || 0,
      status: (updated.status || 'ACTIVE').toUpperCase(),
      created_at: updated.created_at,
      updated_at: updated.updated_at
    };
  }

  /**
   * Update department status
   */
  async updateDepartmentStatus(id, status) {
    return this.updateDepartment(id, { status });
  }

  /**
   * Delete department (Safe Deletion Rule: prevents deleting if courses exist under it)
   */
  async deleteDepartment(id) {
    const table = await this.getTableName();
    const existing = await this.getDepartmentById(id);
    if (!existing) {
      throw { statusCode: 404, message: 'Department not found.' };
    }

    // Hierarchy Check: Department MUST NOT be deleted if it contains 1 or more courses
    const { data: courses, error: courseCheckErr } = await supabase
      .from('courses')
      .select('id')
      .eq('category_id', id);

    if (courseCheckErr) {
      console.warn('Department deletion course check warning:', courseCheckErr.message);
    } else if (courses && courses.length > 0) {
      console.log(`[DEPARTMENT DELETE CHECK] Department '${id}' contains ${courses.length} courses. Rejection triggered.`);
      throw {
        statusCode: 422,
        code: 'DEPARTMENT_HAS_COURSES',
        message: 'Cannot delete department because it contains courses.',
        details: {
          department_id: id,
          course_count: courses.length
        }
      };
    }

    const { error } = await supabase
      .from(table)
      .delete()
      .eq('id', id);

    if (error) throw error;
    clearDepartmentCache();
    return true;
  }
}

module.exports = new DepartmentService();
