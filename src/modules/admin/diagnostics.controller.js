const express = require('express');
const router = express.Router();
const { supabase } = require('../../config/supabase');
const { authenticateJWT } = require('../../middleware/authenticate');
const { requireAdminRole } = require('../../middleware/authorize');

router.get('/admin/diagnostics', authenticateJWT, requireAdminRole, async (req, res, next) => {
  try {
    const report = {
      timestamp: new Date().toISOString(),
      status: 'SUCCESS',
      summary: {
        totalCourses: 0,
        validCourses: 0,
        invalidCourses: 0,
        inconsistenciesCount: 0
      },
      inconsistencies: []
    };

    // Fetch all courses
    const { data: courses, error: coursesErr } = await supabase.from('courses').select('*');
    if (coursesErr) throw coursesErr;

    // Fetch departments
    const { data: depts } = await supabase.from('categories').select('*');
    const deptMap = new Map((depts || []).map(d => [d.id, d]));

    // Fetch pricing plans
    const { data: pricingPlans } = await supabase.from('pricing_plans').select('*, installments(*)');
    const pricingByCourse = new Map();
    (pricingPlans || []).forEach(plan => {
      if (!pricingByCourse.has(plan.course_id)) {
        pricingByCourse.set(plan.course_id, []);
      }
      pricingByCourse.get(plan.course_id).push(plan);
    });

    report.summary.totalCourses = (courses || []).length;

    for (const c of (courses || [])) {
      const courseIssues = [];

      // 1. Department Check
      if (!c.category_id && !c.department_id) {
        courseIssues.push(`Missing department reference on course '${c.title || c.id}'.`);
      } else {
        const deptId = c.category_id || c.department_id;
        if (!deptMap.has(deptId)) {
          courseIssues.push(`Referenced department '${deptId}' does not exist in database.`);
        }
      }

      // 2. Title & Slug Check
      if (!c.title || c.title.trim() === '') {
        courseIssues.push(`Course '${c.id}' has missing or empty title.`);
      }
      if (!c.slug || c.slug.trim() === '') {
        courseIssues.push(`Course '${c.id}' has missing or empty slug.`);
      }

      // 3. Status Check
      if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(c.status || 'PUBLISHED')) {
        courseIssues.push(`Course '${c.title}' has invalid status '${c.status}'.`);
      }

      // 4. Pricing & Installment Checks
      const plans = pricingByCourse.get(c.id) || [];
      const instPlan = plans.find(p => p.plan_type === 'INSTALLMENT');
      if (instPlan) {
        const phases = instPlan.installments || [];
        if (phases.length > 0) {
          const sum = phases.reduce((acc, curr) => acc + (Number(curr.amount) || 0), 0);
          if (sum !== Number(instPlan.total_amount)) {
            courseIssues.push(`Installment phase sum (${sum}) does not equal plan total_amount (${instPlan.total_amount}) for course '${c.title}'.`);
          }
          const numbers = phases.map(p => p.installment_number || p.phase_number);
          if (new Set(numbers).size !== numbers.length) {
            courseIssues.push(`Duplicate installment phase numbers found for course '${c.title}'.`);
          }
        }
      }

      if (courseIssues.length > 0) {
        report.summary.invalidCourses += 1;
        report.summary.inconsistenciesCount += courseIssues.length;
        report.inconsistencies.push({
          courseId: c.id,
          title: c.title,
          slug: c.slug,
          issues: courseIssues
        });
      } else {
        report.summary.validCourses += 1;
      }
    }

    return res.status(200).json(report);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
