const { supabase } = require('../../config/supabase');
const { calculateDiscountedPricing } = require('../../utils/pricingEngine');
const courseService = require('../courses/course.service');
const departmentService = require('../departments/department.service');

// Fallback in-memory coupon store for development/testing if database table columns are limited
const inMemoryCoupons = new Map([
  ['WELCOME10', {
    id: 'c-wel10',
    code: 'WELCOME10',
    description: 'Welcome 10% Off Discount',
    discount_type: 'PERCENTAGE',
    discount_value: 10,
    discount_amount: 10,
    status: 'ACTIVE',
    applicability: 'GLOBAL',
    starts_at: new Date('2025-01-01').toISOString(),
    expires_at: null,
    usage_limit: null,
    used_count: 0,
    is_visible_on_site: true
  }],
  ['EARLY2026', {
    id: 'c-early2026',
    code: 'EARLY2026',
    description: 'Early Bird ₹500 Instant Discount',
    discount_type: 'FIXED_AMOUNT',
    discount_value: 500,
    discount_amount: 500,
    status: 'ACTIVE',
    applicability: 'GLOBAL',
    starts_at: new Date('2025-01-01').toISOString(),
    expires_at: null,
    usage_limit: null,
    used_count: 0,
    is_visible_on_site: true
  }],
  ['16/08/26-INLS', {
    id: 'c-inls1000',
    code: '16/08/26-INLS',
    description: 'Special NLS Cohort ₹1,000 Discount',
    discount_type: 'FIXED_AMOUNT',
    discount_value: 1000,
    discount_amount: 1000,
    status: 'ACTIVE',
    applicability: 'GLOBAL',
    starts_at: new Date('2025-01-01').toISOString(),
    expires_at: null,
    usage_limit: null,
    used_count: 0,
    is_visible_on_site: true
  }]
]);

class CouponService {
  /**
   * Helper to serialize extended restriction attributes into description column for DB persistence
   */
  encodeCouponMetadata(data) {
    const meta = {
      applicability: (data.applicability || 'GLOBAL').toUpperCase(),
      course_id: data.course_id || null,
      department_id: data.department_id || null,
      discount_type: (data.discount_type || 'PERCENTAGE').toUpperCase(),
      discount_value: Number(data.discount_value !== undefined ? data.discount_value : (data.discount_amount || 0)),
      minimum_course_amount: Number(data.minimum_course_amount || 0),
      usage_limit: data.usage_limit ? Number(data.usage_limit) : null,
      starts_at: data.starts_at || null,
      expires_at: data.expires_at || null,
      is_visible_on_site: data.is_visible_on_site !== undefined ? Boolean(data.is_visible_on_site) : true
    };

    const rawDesc = String(data.description || '');
    const cleanDesc = rawDesc.replace(/\s*__META__.*$/, '').trim();
    return `${cleanDesc} __META__${JSON.stringify(meta)}`;
  }

  /**
   * Helper to deserialize extended restriction attributes from description column
   */
  parseCouponMetadata(rawDesc) {
    if (!rawDesc || typeof rawDesc !== 'string') {
      return { description: '', meta: null };
    }
    const parts = rawDesc.split(' __META__');
    const description = parts[0].trim();
    if (parts.length > 1) {
      try {
        const meta = JSON.parse(parts[1]);
        return { description, meta };
      } catch {
        return { description, meta: null };
      }
    }
    return { description, meta: null };
  }

  /**
   * Helper to inspect coupons table availability
   */
  async isTableAvailable() {
    try {
      const { data, error } = await supabase.from('coupons').select('id').limit(1);
      if (error) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all coupons (Admin)
   */
  async getAllCoupons() {
    const couponMap = new Map();

    // 1. Seed with inMemoryCoupons first
    for (const [code, item] of inMemoryCoupons.entries()) {
      couponMap.set(code, this.formatCoupon(item));
    }

    // 2. Fetch from Supabase and merge
    try {
      const { data, error } = await supabase
        .from('coupons')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const formatted = this.formatCoupon(row);
          if (formatted && formatted.code) {
            const existing = couponMap.get(formatted.code);
            couponMap.set(formatted.code, {
              ...(existing || {}),
              ...formatted
            });
          }
        }
      }
    } catch (err) {
      console.warn("Coupons DB table query note:", err.message || err);
    }

    return Array.from(couponMap.values());
  }

  /**
   * Get single coupon by normalized code
   */
  async getCouponByCode(code) {
    if (!code) return null;
    const cleanCode = String(code).trim().toUpperCase();
    const mem = inMemoryCoupons.get(cleanCode);
    const formattedMem = mem ? this.formatCoupon(mem) : null;

    try {
      const { data, error } = await supabase
        .from('coupons')
        .select('*')
        .eq('code', cleanCode)
        .maybeSingle();

      if (!error && data) {
        const formattedDb = this.formatCoupon(data);
        return {
          ...formattedDb,
          ...(formattedMem || {}),
          id: formattedDb.id || formattedMem?.id,
          code: formattedDb.code || formattedMem?.code,
          discount_type: formattedDb.discount_type || formattedMem?.discount_type,
          discount_value: formattedDb.discount_value !== undefined ? formattedDb.discount_value : formattedMem?.discount_value,
          discount_amount: formattedDb.discount_amount !== undefined ? formattedDb.discount_amount : formattedMem?.discount_amount,
          applicability: formattedDb.applicability || formattedMem?.applicability,
          course_id: formattedDb.course_id || formattedMem?.course_id,
          department_id: formattedDb.department_id || formattedMem?.department_id
        };
      }
    } catch (err) {
      console.warn("Coupons DB table note:", err.message || err);
    }

    return formattedMem;
  }

  /**
   * Get single coupon by ID
   */
  async getCouponById(id) {
    if (!id) return null;
    const memObj = Array.from(inMemoryCoupons.values()).find(c => c.id === id);
    const formattedMem = memObj ? this.formatCoupon(memObj) : null;

    try {
      const { data, error } = await supabase
        .from('coupons')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (!error && data) {
        const formattedDb = this.formatCoupon(data);
        return {
          ...formattedDb,
          ...(formattedMem || {}),
          id: formattedDb.id || formattedMem?.id,
          code: formattedDb.code || formattedMem?.code,
          discount_type: formattedDb.discount_type || formattedMem?.discount_type,
          discount_value: formattedDb.discount_value !== undefined ? formattedDb.discount_value : formattedMem?.discount_value,
          discount_amount: formattedDb.discount_amount !== undefined ? formattedDb.discount_amount : formattedMem?.discount_amount,
          applicability: formattedDb.applicability || formattedMem?.applicability,
          course_id: formattedDb.course_id || formattedMem?.course_id,
          department_id: formattedDb.department_id || formattedMem?.department_id
        };
      }
    } catch (err) {
      console.warn("Coupons DB table note:", err.message || err);
    }

    return formattedMem;
  }

  /**
   * Create new coupon (Admin)
   */
  async createCoupon(data) {
    const cleanCode = data.code.trim().toUpperCase();
    const existing = await this.getCouponByCode(cleanCode);
    if (existing) {
      throw { statusCode: 409, message: `Coupon with code '${cleanCode}' already exists.` };
    }

    let createdRecord = null;
    const encodedDescription = this.encodeCouponMetadata(data);

    // 1. Try full insert into Supabase first
    try {
      const fullPayload = {
        ...data,
        code: cleanCode,
        description: encodedDescription
      };
      const { data: created, error } = await supabase
        .from('coupons')
        .insert([fullPayload])
        .select()
        .single();

      if (!error && created) {
        createdRecord = created;
      }
    } catch (err) {
      console.warn("Coupons full DB insert note:", err.message || err);
    }

    // 2. If full insert failed due to column schema mismatch, try schema-safe base insert with encoded metadata in description
    if (!createdRecord) {
      try {
        const basePayload = {
          code: cleanCode,
          description: encodedDescription,
          discount_amount: Number(data.discount_value !== undefined ? data.discount_value : (data.discount_amount || 0)),
          status: (data.status || 'ACTIVE').toUpperCase(),
          created_at: new Date().toISOString()
        };

        const { data: createdBase, error: baseErr } = await supabase
          .from('coupons')
          .insert([basePayload])
          .select()
          .single();

        if (!baseErr && createdBase) {
          createdRecord = createdBase;
        } else if (baseErr) {
          console.warn("Coupons base DB insert note:", baseErr.message);
        }
      } catch (err) {
        console.warn("Coupons base DB insert note:", err.message || err);
      }
    }

    // 3. Construct unified coupon object merging DB result + memory attributes
    const finalId = createdRecord?.id || `c-${Date.now()}`;
    const fullCouponObject = {
      id: finalId,
      code: cleanCode,
      description: encodedDescription,
      discount_type: (data.discount_type || 'PERCENTAGE').toUpperCase(),
      discount_value: Number(data.discount_value !== undefined ? data.discount_value : (data.discount_amount || 0)),
      discount_amount: Number(data.discount_amount !== undefined ? data.discount_amount : (data.discount_value || 0)),
      status: (data.status || 'ACTIVE').toUpperCase(),
      applicability: (data.applicability || 'GLOBAL').toUpperCase(),
      course_id: data.course_id || null,
      department_id: data.department_id || null,
      minimum_course_amount: Number(data.minimum_course_amount || 0),
      usage_limit: data.usage_limit ? Number(data.usage_limit) : null,
      used_count: Number(data.used_count || 0),
      starts_at: data.starts_at || new Date().toISOString(),
      expires_at: data.expires_at || null,
      created_at: createdRecord?.created_at || new Date().toISOString(),
      updated_at: createdRecord?.updated_at || new Date().toISOString()
    };

    inMemoryCoupons.set(cleanCode, fullCouponObject);

    return this.formatCoupon(fullCouponObject);
  }

  /**
   * Update existing coupon (Admin)
   */
  async updateCoupon(id, updateData) {
    const existing = await this.getCouponById(id);
    if (!existing) {
      throw { statusCode: 404, message: 'Coupon not found.' };
    }

    if (updateData.code && updateData.code.toUpperCase() !== existing.code) {
      const codeMatch = await this.getCouponByCode(updateData.code);
      if (codeMatch && codeMatch.id !== id) {
        throw { statusCode: 409, message: `Coupon code '${updateData.code}' is already used by another coupon.` };
      }
    }

    const mergedData = {
      ...existing,
      ...updateData
    };
    const encodedDescription = this.encodeCouponMetadata(mergedData);

    const updatedMemoryObj = {
      ...mergedData,
      description: encodedDescription,
      updated_at: new Date().toISOString()
    };

    try {
      const baseUpdate = {
        code: updateData.code ? String(updateData.code).toUpperCase() : undefined,
        status: updateData.status ? String(updateData.status).toUpperCase() : undefined,
        description: encodedDescription,
        discount_amount: updateData.discount_value !== undefined ? Number(updateData.discount_value) : undefined
      };
      Object.keys(baseUpdate).forEach(k => baseUpdate[k] === undefined && delete baseUpdate[k]);

      const baseRes = await supabase
        .from('coupons')
        .update(baseUpdate)
        .eq('id', id)
        .select()
        .maybeSingle();

      if (baseRes.data) {
        console.log("Coupons DB update succeeded for ID:", id);
      }
    } catch (err) {
      console.warn("Coupons DB update note:", err.message || err);
    }

    if (existing.code) inMemoryCoupons.delete(existing.code);
    const newCode = (updateData.code || existing.code).toUpperCase();
    inMemoryCoupons.set(newCode, updatedMemoryObj);

    return this.formatCoupon(updatedMemoryObj);
  }

  /**
   * Delete or deactivate coupon (Admin)
   */
  async deleteCoupon(id) {
    const existing = await this.getCouponById(id);
    if (!existing) {
      throw { statusCode: 404, message: 'Coupon not found.' };
    }

    try {
      await supabase.from('coupons').delete().eq('id', id);
    } catch (err) {
      console.warn("Coupons DB delete note:", err.message || err);
    }

    if (existing.code) inMemoryCoupons.delete(existing.code);
    return true;
  }

  /**
   * Atomically increment used count when purchase succeeds
   */
  async incrementUsage(couponId) {
    if (!couponId) return;
    const hasTable = await this.isTableAvailable();
    if (hasTable) {
      try {
        await supabase.rpc('increment_coupon_usage', { coupon_id_param: couponId });
      } catch {
        const coupon = await this.getCouponById(couponId);
        if (coupon) {
          const newCount = (coupon.used_count || 0) + 1;
          const newStatus = (coupon.usage_limit && newCount >= coupon.usage_limit) ? 'EXHAUSTED' : coupon.status;
          await supabase.from('coupons').update({ used_count: newCount, status: newStatus }).eq('id', couponId);
        }
      }
      return;
    }

    for (const mem of inMemoryCoupons.values()) {
      if (mem.id === couponId) {
        mem.used_count = (mem.used_count || 0) + 1;
        if (mem.usage_limit && mem.used_count >= mem.usage_limit) {
          mem.status = 'EXHAUSTED';
        }
        break;
      }
    }
  }

  /**
   * CANONICAL COUPON VALIDATION ENGINE
   * Validates coupon against course eligibility, expiration, usage limits, and calculates canonical pricing breakdown.
   */
  async validateCouponForCourse({ code, courseId, paymentMode = 'FULL' }) {
    if (!code) {
      throw { statusCode: 400, message: 'Coupon code is required.' };
    }
    if (!courseId) {
      throw { statusCode: 400, message: 'courseId is required.' };
    }

    const cleanCode = String(code).trim().toUpperCase();
    const coupon = await this.getCouponByCode(cleanCode);

    if (!coupon) {
      throw { statusCode: 404, message: `Coupon code '${cleanCode}' does not exist.` };
    }

    // 1. Status Check
    if (coupon.status === 'DISABLED') {
      throw { statusCode: 422, message: `Coupon '${cleanCode}' is currently disabled.` };
    }
    if (coupon.status === 'EXHAUSTED') {
      throw { statusCode: 422, message: `Coupon '${cleanCode}' usage limit has been reached.` };
    }
    if (coupon.status === 'EXPIRED') {
      throw { statusCode: 422, message: `Coupon '${cleanCode}' has expired.` };
    }

    // 2. Date Expiration Check
    const now = new Date();
    if (coupon.starts_at && new Date(coupon.starts_at) > now) {
      throw { statusCode: 422, message: `Coupon '${cleanCode}' is not active yet.` };
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < now) {
      throw { statusCode: 422, message: `Coupon '${cleanCode}' has expired.` };
    }

    // 3. Usage Limit Check
    if (coupon.usage_limit !== null && coupon.usage_limit !== undefined) {
      if ((coupon.used_count || 0) >= coupon.usage_limit) {
        throw { statusCode: 422, message: `Coupon '${cleanCode}' maximum redemption limit reached.` };
      }
    }

    // 4. Fetch Canonical Course Object
    const course = await courseService.getCourseByIdentifier(courseId, true);
    if (!course) {
      throw { statusCode: 404, message: `Course not found for identifier '${courseId}'.` };
    }

    // Resolve Department Info for Course
    let deptName = course.department_name || course.category || 'General Academic Department';
    let deptId = course.department_id || null;
    let deptSlug = course.department_slug || '';

    if (!deptName || deptName === 'General Academic Department') {
      if (deptId) {
        try {
          const deptObj = await departmentService.getDepartmentById(deptId);
          if (deptObj) {
            deptName = deptObj.name || deptName;
            deptSlug = deptObj.slug || deptSlug;
          }
        } catch (err) {
          console.warn("Department lookup note for coupon validation:", err.message || err);
        }
      }
    }

    console.log("[COUPON VALIDATION]");
    console.log("  Coupon:", cleanCode);
    console.log("  Requested Course:", courseId);
    console.log("  Resolved Course:", course.title, `(ID: ${course.id}, Slug: ${course.slug})`);
    console.log("  Resolved Category/Department:", deptName, `(ID: ${deptId}, Slug: ${deptSlug})`);
    console.log("  Coupon Applicability:", coupon.applicability);
    console.log("  Coupon Course Restrictions:", coupon.course_id);
    console.log("  Coupon Department Restrictions:", coupon.department_id);

    // 5. Course & Department Eligibility Check (Strict Scope Validation)
    const app = (coupon.applicability || 'GLOBAL').toUpperCase();

    // 5a. Check Course Restriction if applicability === 'COURSE' or course_id is set
    const targetCourseId = coupon.course_id;
    const isCourseRestricted = app === 'COURSE' || (targetCourseId !== null && targetCourseId !== undefined && targetCourseId !== '');

    if (isCourseRestricted) {
      if (!targetCourseId) {
        console.log("  Eligibility Result: REJECTED");
        console.log("  Rejection Reason: Coupon is course-restricted but no course_id was configured.");
        throw { statusCode: 422, message: "This coupon is not valid for this course." };
      }

      const allowedCourses = Array.isArray(targetCourseId) ? targetCourseId : [targetCourseId];
      const courseMatch = allowedCourses.some(cId => {
        if (!cId) return false;
        const strCId = String(cId).trim().toLowerCase();
        return (
          strCId === String(course.id).trim().toLowerCase() ||
          strCId === String(course.slug).trim().toLowerCase()
        );
      });

      if (!courseMatch) {
        console.log("  Eligibility Result: REJECTED");
        console.log("  Rejection Reason: Course restriction mismatch");
        throw { statusCode: 422, message: "This coupon is not valid for this course." };
      }
    }

    // 5b. Check Department Restriction if applicability === 'DEPARTMENT' or department_id is set
    const targetDeptId = coupon.department_id;
    const isDeptRestricted = app === 'DEPARTMENT' || (targetDeptId !== null && targetDeptId !== undefined && targetDeptId !== '');

    if (isDeptRestricted) {
      if (!targetDeptId) {
        console.log("  Eligibility Result: REJECTED");
        console.log("  Rejection Reason: Coupon is department-restricted but no department_id was configured.");
        throw { statusCode: 422, message: "This coupon is not valid for this department." };
      }

      const allowedDepts = Array.isArray(targetDeptId) ? targetDeptId : [targetDeptId];
      const deptMatch = allowedDepts.some(dId => {
        if (!dId) return false;
        const strDId = String(dId).trim().toLowerCase();
        return (
          strDId === String(deptId || '').trim().toLowerCase() ||
          strDId === String(deptSlug || '').trim().toLowerCase() ||
          strDId === String(deptName || '').trim().toLowerCase()
        );
      });

      if (!deptMatch) {
        console.log("  Eligibility Result: REJECTED");
        console.log("  Rejection Reason: Department restriction mismatch");
        throw { statusCode: 422, message: "This coupon is not valid for this department." };
      }
    }

    console.log("  Eligibility Result: ALLOWED");

    // 6. Calculate Pricing Breakdown via Canonical Pricing Engine
    const pricingService = require('../pricing/pricing.service');
    const pricingData = await pricingService.getPricingForCourse(course.id).catch(() => null);
    const plans = pricingData?.pricingPlans || [];
    const fullPlan = plans.find(p => p.paymentMode === 'FULL');
    const instPlan = plans.find(p => p.paymentMode === 'INSTALLMENT');
    const targetMode = String(paymentMode || 'FULL').toUpperCase();
    const activePlan = targetMode === 'INSTALLMENT' ? (instPlan || fullPlan) : (fullPlan || instPlan);
    const activePhases = instPlan?.phases || [];

    // 7. Minimum Course Amount Check
    const coursePrice = Number(course.price || activePlan?.totalAmount || 0);
    if (coupon.minimum_course_amount && coursePrice < Number(coupon.minimum_course_amount)) {
      throw { statusCode: 422, message: `Minimum course total of ₹${coupon.minimum_course_amount} required to use coupon '${cleanCode}'.` };
    }

    const breakdown = calculateDiscountedPricing({
      course,
      pricingPlan: activePlan ? { total_amount: activePlan.totalAmount } : null,
      installments: activePhases.map(p => ({ amount: p.amount, phaseNumber: p.phaseNumber })),
      coupon,
      paymentMode: targetMode
    });

    return {
      valid: true,
      coupon,
      course: {
        id: course.id,
        title: course.title,
        slug: course.slug,
        department_id: deptId,
        department_name: deptName
      },
      pricing: breakdown
    };
  }

  /**
   * Helper to format coupon response object with dynamic status computation
   */
  formatCoupon(c) {
    if (!c) return null;
    const now = new Date();

    const { description: cleanDescription, meta } = this.parseCouponMetadata(c.description);

    let baseStatus = (c.status || meta?.status || 'ACTIVE').toUpperCase();
    let computedStatus = baseStatus;

    const expiresAt = c.expires_at || meta?.expires_at || null;
    const startsAt = c.starts_at || meta?.starts_at || null;
    const usageLimit = c.usage_limit !== undefined && c.usage_limit !== null 
      ? Number(c.usage_limit) 
      : (meta?.usage_limit ? Number(meta.usage_limit) : null);
    const usedCount = Number(c.used_count !== undefined ? c.used_count : (meta?.used_count || 0));

    if (baseStatus !== 'DISABLED') {
      if (expiresAt && new Date(expiresAt) < now) {
        computedStatus = 'EXPIRED';
      } else if (startsAt && new Date(startsAt) > now) {
        computedStatus = 'SCHEDULED';
      } else if (usageLimit && usedCount >= usageLimit) {
        computedStatus = 'EXHAUSTED';
      } else {
        computedStatus = 'ACTIVE';
      }
    }

    const discountType = (c.discount_type || meta?.discount_type || 'PERCENTAGE').toUpperCase();
    const val = c.discount_value !== undefined && c.discount_value !== null 
      ? Number(c.discount_value) 
      : (meta?.discount_value !== undefined ? Number(meta.discount_value) : Number(c.discount_amount || 0));

    const applicability = (c.applicability || meta?.applicability || 'GLOBAL').toUpperCase();
    const courseId = c.course_id || meta?.course_id || null;
    const departmentId = c.department_id || meta?.department_id || null;
    const minAmount = c.minimum_course_amount !== undefined && c.minimum_course_amount !== null
      ? Number(c.minimum_course_amount)
      : Number(meta?.minimum_course_amount || 0);

    const isVisibleOnSite = c.is_visible_on_site !== undefined
      ? Boolean(c.is_visible_on_site)
      : (meta?.is_visible_on_site !== undefined ? Boolean(meta.is_visible_on_site) : true);

    return {
      id: c.id,
      code: String(c.code).trim().toUpperCase(),
      description: cleanDescription,
      discount_type: discountType,
      discount_value: val,
      discount_amount: val,
      status: computedStatus,
      raw_status: c.status,
      starts_at: startsAt,
      expires_at: expiresAt,
      usage_limit: usageLimit,
      used_count: usedCount,
      per_user_limit: Number(c.per_user_limit || 1),
      minimum_course_amount: minAmount,
      maximum_discount_amount: c.maximum_discount_amount ? Number(c.maximum_discount_amount) : null,
      applicability,
      course_id: courseId,
      department_id: departmentId,
      is_visible_on_site: isVisibleOnSite,
      show_on_site: isVisibleOnSite,
      created_at: c.created_at || new Date().toISOString(),
      updated_at: c.updated_at || new Date().toISOString()
    };
  }

  /**
   * Public API: Get all active coupons visible on the main site
   * Optional courseId to filter for global + course-applicable coupons
   */
  async getPublicCoupons(courseId = null) {
    const allCoupons = await this.getAllCoupons();
    const cleanCourseId = courseId ? String(courseId).trim().toLowerCase() : null;

    let targetCourse = null;
    if (cleanCourseId) {
      targetCourse = await courseService.getCourseByIdentifier(cleanCourseId, false).catch(() => null);
    }

    return allCoupons.filter(c => {
      // Must be ACTIVE
      if (c.status !== 'ACTIVE') return false;
      // Must be marked visible on site
      if (c.is_visible_on_site === false) return false;

      // If course is specified, filter by applicability
      if (targetCourse) {
        const app = (c.applicability || 'GLOBAL').toUpperCase();
        if (app === 'GLOBAL') return true;
        if (app === 'COURSE') {
          const allowed = Array.isArray(c.course_id) ? c.course_id : [c.course_id];
          return allowed.some(cId => {
            if (!cId) return false;
            const str = String(cId).trim().toLowerCase();
            return str === String(targetCourse.id).toLowerCase() || str === String(targetCourse.slug).toLowerCase();
          });
        }
        if (app === 'DEPARTMENT') {
          const allowed = Array.isArray(c.department_id) ? c.department_id : [c.department_id];
          const deptId = targetCourse.department_id || targetCourse.category_id;
          const deptSlug = targetCourse.department_slug;
          return allowed.some(dId => {
            if (!dId) return false;
            const str = String(dId).trim().toLowerCase();
            return str === String(deptId).toLowerCase() || str === String(deptSlug).toLowerCase();
          });
        }
        return false;
      }

      return true;
    });
  }
}

module.exports = new CouponService();

