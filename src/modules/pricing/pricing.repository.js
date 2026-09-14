const { supabase } = require("../../config/supabase");

class PricingRepository {
  /**
   * Find course record by UUID or slug
   */
  async findCourseByIdOrSlug(idOrSlug) {
    if (!idOrSlug) return null;
    let resolved = idOrSlug;
    if (typeof idOrSlug === 'object' && idOrSlug !== null) {
      resolved = idOrSlug.courseId || idOrSlug.course_id || idOrSlug.id || idOrSlug.slug;
    }
    if (!resolved) return null;
    const clean = String(resolved).trim();
    if (clean === '[object Object]' || clean.length === 0) return null;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean);

    let query = supabase.from("courses").select("id, title, slug, price, installment_price, status, is_published");
    if (isUuid) {
      query = query.eq("id", clean);
    } else {
      query = query.ilike("slug", clean);
    }

    const { data: courses, error } = await query.limit(1);
    if (!error && courses && courses.length > 0) return courses[0];

    // Fallback search by title if slug didn't match
    if (!isUuid) {
      const { data: titleCourses } = await supabase
        .from("courses")
        .select("id, title, slug, price, installment_price, status, is_published")
        .ilike("title", `%${clean.replace(/[-_]/g, " ")}%`)
        .limit(1);
      if (titleCourses && titleCourses.length > 0) return titleCourses[0];
    }

    return null;
  }

  /**
   * Find pricing rows for a course ID
   */
  async findPricingByCourseId(courseId, activeOnly = true) {
    let query = supabase.from("course_pricing").select("*").eq("course_id", courseId);
    if (activeOnly) {
      query = query.eq("is_active", true);
    }
    const { data, error } = await query;
    if (error) {
      console.error(`PricingRepository findPricingByCourseId error for course '${courseId}':`, error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Find all active course pricing rows
   */
  async findAllActivePricing() {
    const { data, error } = await supabase.from("course_pricing").select("*").eq("is_active", true);
    if (error) {
      console.error("PricingRepository findAllActivePricing error:", error.message);
      return { data: [], error };
    }
    return { data: data || [], error: null };
  }

  /**
   * Find pricing row by ID
   */
  async findPricingById(pricingId) {
    if (!pricingId) return null;
    const { data, error } = await supabase
      .from("course_pricing")
      .select("*")
      .eq("id", pricingId)
      .limit(1);

    if (error || !data || data.length === 0) return null;
    return data[0];
  }

  /**
   * Upsert single active pricing row for a course
   */
  async upsertPricing(pricingPayload) {
    if (pricingPayload.course_id && !pricingPayload.id) {
      const existing = await this.findPricingByCourseId(pricingPayload.course_id, false);
      if (existing && existing.length > 0) {
        pricingPayload.id = existing[0].id;
      }
    }

    const { data, error } = await supabase
      .from("course_pricing")
      .upsert(pricingPayload)
      .select()
      .single();

    if (error) {
      console.error("PricingRepository upsertPricing error:", error.message);
      throw { statusCode: 500, message: `Failed to persist pricing plan: ${error.message}` };
    }
    return data;
  }

  /**
   * Deactivate default pricing plan for a course if required
   */
  async deactivateOtherCoursePricing(courseId, keepId = null) {
    let query = supabase
      .from("course_pricing")
      .update({ is_active: false })
      .eq("course_id", courseId);

    if (keepId) {
      query = query.neq("id", keepId);
    }
    await query;
  }

  /**
   * Delete pricing record
   */
  async deletePricing(pricingId) {
    const { error } = await supabase.from("course_pricing").delete().eq("id", pricingId);
    if (error) {
      throw { statusCode: 500, message: `Failed to delete pricing plan: ${error.message}` };
    }
    return true;
  }
}

module.exports = new PricingRepository();
