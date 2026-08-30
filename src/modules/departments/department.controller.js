const departmentService = require('./department.service');
const { successResponse } = require('../../utils/response');

class DepartmentController {
  /**
   * GET /api/departments
   */
  async getDepartments(req, res, next) {
    try {
      console.log('\n📥 [DEPARTMENT READ FLOW] GET /api/departments');
      const includeAll = req.query.includeAll === 'true' || req.userRole === 'ADMIN';
      const departments = await departmentService.getAllDepartments(includeAll);
      console.log(` 🏢 [DEPARTMENT READ FLOW] Returning ${departments.length} departments.`);
      return successResponse(res, { departments });
    } catch (err) {
      console.error(' ❌ [DEPARTMENT GET ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * GET /api/departments/id/:id
   */
  async getDepartmentById(req, res, next) {
    try {
      const { id } = req.params;
      console.log(`\n📥 [DEPARTMENT READ FLOW] GET /api/departments/id/${id}`);
      const department = await departmentService.getDepartmentById(id);
      if (!department) {
        return res.status(404).json({ status: 'ERROR', message: `Department not found with id '${id}'.` });
      }
      return successResponse(res, { department });
    } catch (err) {
      console.error(' ❌ [DEPARTMENT GET BY ID ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * GET /api/departments/slug/:slug
   */
  async getDepartmentBySlug(req, res, next) {
    try {
      const { slug } = req.params;
      console.log(`\n📥 [DEPARTMENT READ FLOW] GET /api/departments/slug/${slug}`);
      const department = await departmentService.getDepartmentBySlug(slug);
      if (!department) {
        return res.status(404).json({ status: 'ERROR', message: `Department not found with slug '${slug}'.` });
      }
      return successResponse(res, { department });
    } catch (err) {
      console.error(' ❌ [DEPARTMENT GET BY SLUG ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * GET /api/departments/:identifier
   */
  async getDepartmentByIdentifier(req, res, next) {
    try {
      const { identifier } = req.params;
      console.log(`\n📥 [DEPARTMENT READ FLOW] GET /api/departments/${identifier}`);
      const department = await departmentService.getDepartmentByIdentifier(identifier);
      if (!department) {
        return res.status(404).json({ status: 'ERROR', message: `Department not found with identifier '${identifier}'.` });
      }
      return successResponse(res, { department });
    } catch (err) {
      console.error(' ❌ [DEPARTMENT GET BY IDENTIFIER ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * POST /api/departments
   */
  async createDepartment(req, res, next) {
    try {
      console.log('\n============================================================');
      console.log(' 🏢 [DEPARTMENT CREATE DATA FLOW] Incoming Payload:');
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const department = await departmentService.createDepartment(req.validatedData);
      console.log(' 🏢 [DEPARTMENT CREATE DATA FLOW] Result in DB:');
      console.log(JSON.stringify(department, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { department }, 201, 'Department created successfully.');
    } catch (err) {
      console.error(' ❌ [DEPARTMENT CREATE ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * PUT /api/departments/:id
   */
  async updateDepartment(req, res, next) {
    try {
      const { id } = req.params;
      console.log('\n============================================================');
      console.log(` 🏢 [DEPARTMENT UPDATE DATA FLOW] ID: ${id}, Payload:`);
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const department = await departmentService.updateDepartment(id, req.validatedData);
      console.log(' 🏢 [DEPARTMENT UPDATE DATA FLOW] Updated in DB:');
      console.log(JSON.stringify(department, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { department }, 200, 'Department updated successfully.');
    } catch (err) {
      console.error(' ❌ [DEPARTMENT UPDATE ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * PATCH /api/departments/:id/status
   */
  async updateStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { status } = req.validatedData;
      console.log(`\n🏢 [DEPARTMENT STATUS DATA FLOW] ID: ${id}, New Status: ${status}`);
      const department = await departmentService.updateDepartmentStatus(id, status);
      return successResponse(res, { department }, 200, 'Department status updated successfully.');
    } catch (err) {
      console.error(' ❌ [DEPARTMENT STATUS UPDATE ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * DELETE /api/departments/:id
   */
  async deleteDepartment(req, res, next) {
    try {
      const { id } = req.params;
      console.log(`\n🏢 [DEPARTMENT DELETE DATA FLOW] ID: ${id}`);
      await departmentService.deleteDepartment(id);
      console.log(` 🏢 [DEPARTMENT DELETE DATA FLOW] Deleted Department ID: ${id}`);
      return successResponse(res, null, 200, 'Department deleted successfully.');
    } catch (err) {
      console.error(' ❌ [DEPARTMENT DELETE ERROR]:', err.message || err);
      next(err);
    }
  }
}

module.exports = new DepartmentController();
