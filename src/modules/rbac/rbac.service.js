/**
 * Role-Based Access Control (RBAC) & Audit Logging Service
 * Hardened for Finding 9: Explicit Fail-Closed Semantics and Removal of In-Memory Sub-User Store.
 */

const { supabase } = require('../../config/supabase');
const { ROLES, PERMISSIONS } = require('./rbac.constants');
const env = require('../../config/env');

// Master Super Admin Email Whitelist
const SUPER_ADMIN_EMAILS = [
  'admin@internnetra.com',
  (env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim()
].filter(Boolean);

// In-Memory Ring Buffer for Audit Trail (Log display only, NEVER used for authorization)
const memoryAuditLogStore = [];

class RbacService {
  /**
   * Helper to determine if an email belongs to Super Admin
   */
  isSuperAdminEmail(email) {
    if (!email) return false;
    const clean = String(email).toLowerCase().trim();
    return SUPER_ADMIN_EMAILS.includes(clean);
  }

  /**
   * 1. Resolve User Role and Granular Permissions
   * FAIL-CLOSED: If the database is unreachable or queries fail, it throws an error
   * or denies administrative access. It NEVER falls back to an in-memory admin store.
   */
  async getUserRoleAndPermissions(user) {
    if (!user || !user.email) {
      return {
        role: ROLES.STUDENT,
        permissions: [],
        isSuperAdmin: false,
        status: 'Unauthenticated'
      };
    }

    const email = String(user.email).toLowerCase().trim();

    // 1. Check if SUPER_ADMIN (Explicit whitelist or explicit super_admin role)
    if (this.isSuperAdminEmail(email) || user.role === ROLES.SUPER_ADMIN || user.user_metadata?.role === ROLES.SUPER_ADMIN) {
      return {
        userId: user.id || 'super-admin-root',
        email,
        name: user.fullName || user.user_metadata?.fullName || 'Super Administrator',
        role: ROLES.SUPER_ADMIN,
        permissions: Object.values(PERMISSIONS),
        isSuperAdmin: true,
        status: 'Active'
      };
    }

    // 2. Check if Delegated ADMIN (authoritative sub_users table)
    let subUser = null;
    try {
      const { data, error } = await supabase
        .from('sub_users')
        .select('*')
        .ilike('email', email)
        .maybeSingle();

      if (error) {
        console.error(`❌ [RBAC Fail-Closed] Database error fetching sub-user (${email}):`, error.message);
        throw {
          statusCode: 503,
          code: 'RBAC_DB_UNAVAILABLE',
          message: 'Authorization database service is currently unavailable. Access denied.'
        };
      }
      subUser = data;
    } catch (dbErr) {
      if (dbErr.statusCode || dbErr.code === 'RBAC_DB_UNAVAILABLE') {
        throw dbErr;
      }
      console.error(`❌ [RBAC Fail-Closed] Exception querying sub_user (${email}):`, dbErr.message || dbErr);
      throw {
        statusCode: 503,
        code: 'RBAC_DB_UNAVAILABLE',
        message: 'Authorization database service error. Access denied.'
      };
    }

    if (subUser) {
      if (subUser.status === 'Disabled') {
        return {
          userId: subUser.id,
          email,
          name: subUser.name,
          role: ROLES.ADMIN,
          permissions: [],
          isSuperAdmin: false,
          status: 'Disabled'
        };
      }

      const assignedPerms = Array.isArray(subUser.permissions)
        ? subUser.permissions
        : (subUser.permissions ? JSON.parse(subUser.permissions) : []);

      return {
        userId: subUser.id,
        email,
        name: subUser.name,
        role: ROLES.ADMIN,
        permissions: assignedPerms,
        isSuperAdmin: false,
        status: subUser.status || 'Active',
        designation: subUser.designation
      };
    }

    // 3. User not found in sub_users and not super admin -> Standard STUDENT
    return {
      userId: user.id || 'student-user',
      email,
      name: user.fullName || user.user_metadata?.fullName || 'Student',
      role: ROLES.STUDENT,
      permissions: [],
      isSuperAdmin: false,
      status: 'Active'
    };
  }

  /**
   * 2. Permission Evaluation Function
   */
  hasPermission(userRbac, requiredPermission) {
    if (!userRbac) return false;
    if (userRbac.status === 'Disabled') return false;
    if (userRbac.role === ROLES.SUPER_ADMIN) return true;
    if (userRbac.role === ROLES.ADMIN) {
      return Array.isArray(userRbac.permissions) && userRbac.permissions.includes(requiredPermission);
    }
    return false;
  }

  /**
   * 3. Create Sub-Admin (SUPER_ADMIN ONLY)
   * FAIL-CLOSED: Persists strictly to database. If database fails, throws error.
   * NEVER creates an in-memory fallback user.
   */
  async createSubAdmin(actorUser, { name, email, designation, permissions = [], status = 'Active', password }) {
    const actorRbac = await this.getUserRoleAndPermissions(actorUser);
    if (actorRbac.role !== ROLES.SUPER_ADMIN) {
      throw {
        statusCode: 403,
        message: 'Privilege Escalation Blocked: Only SUPER_ADMIN can create delegated administrative accounts.'
      };
    }

    if (!name || !email) {
      throw { statusCode: 400, message: 'Name and email are required to create a sub-admin.' };
    }

    const cleanEmail = email.toLowerCase().trim();

    // Prevent creating another Super Admin
    if (this.isSuperAdminEmail(cleanEmail)) {
      throw { statusCode: 400, message: 'Cannot create sub-admin with the master Super Admin email.' };
    }

    // Validate assigned permissions against catalog
    const validPerms = Object.values(PERMISSIONS);
    const sanitizedPerms = (permissions || []).filter(p => validPerms.includes(p));

    const newSubUser = {
      name: name.trim(),
      email: cleanEmail,
      designation: designation || 'Academic Administrator',
      role: ROLES.ADMIN,
      permissions: sanitizedPerms,
      status: status || 'Active',
      created_by: actorRbac.email,
      updated_at: new Date().toISOString()
    };

    const { data: createdRecord, error } = await supabase
      .from('sub_users')
      .insert([newSubUser])
      .select()
      .single();

    if (error || !createdRecord) {
      console.error('❌ [RBAC] Database error creating sub-admin:', error?.message);
      throw {
        statusCode: 500,
        message: `Failed to persist sub-admin in database: ${error?.message || 'Database insert failed'}`
      };
    }

    // Sync password to Supabase Auth if provided
    if (password) {
      try {
        const { error: createErr } = await supabase.auth.admin.createUser({
          email: cleanEmail,
          password: String(password),
          email_confirm: true,
          user_metadata: { fullName: name, role: ROLES.ADMIN }
        });
        if (createErr) {
          const { data: listRes } = await supabase.auth.admin.listUsers();
          const target = (listRes?.users || []).find(u => u.email?.toLowerCase() === cleanEmail);
          if (target?.id) {
            await supabase.auth.admin.updateUserById(target.id, {
              password: String(password),
              email_confirm: true,
              user_metadata: { fullName: name, role: ROLES.ADMIN }
            });
          }
        }
      } catch (authErr) {
        console.warn('Auth sync notice:', authErr.message);
      }
    }

    // Audit Logging
    await this.logAuditEvent({
      actor: actorRbac,
      action: 'admin.created',
      targetResource: 'sub_user',
      targetId: createdRecord.id,
      details: {
        assignedEmail: cleanEmail,
        permissionCount: sanitizedPerms.length,
        permissions: sanitizedPerms
      }
    });

    return createdRecord;
  }

  /**
   * 4. Update Sub-Admin & Permissions (SUPER_ADMIN ONLY)
   * FAIL-CLOSED: Persists strictly to database. Zero in-memory fallback.
   */
  async updateSubAdmin(actorUser, subUserId, { name, designation, permissions, status }) {
    const actorRbac = await this.getUserRoleAndPermissions(actorUser);
    if (actorRbac.role !== ROLES.SUPER_ADMIN) {
      throw {
        statusCode: 403,
        message: 'Privilege Escalation Blocked: Only SUPER_ADMIN can modify sub-admin permissions.'
      };
    }

    const updates = { updated_at: new Date().toISOString() };
    if (name) updates.name = name.trim();
    if (designation) updates.designation = designation.trim();
    if (status) updates.status = status;

    if (Array.isArray(permissions)) {
      const validPerms = Object.values(PERMISSIONS);
      updates.permissions = permissions.filter(p => validPerms.includes(p));
    }

    const { data: updatedRecord, error } = await supabase
      .from('sub_users')
      .update(updates)
      .eq('id', subUserId)
      .select()
      .single();

    if (error || !updatedRecord) {
      console.error('❌ [RBAC] Database error updating sub-admin:', error?.message);
      throw {
        statusCode: error ? 500 : 404,
        message: error ? `Failed to update sub-admin: ${error.message}` : 'Sub-admin record not found.'
      };
    }

    // Audit Logging
    await this.logAuditEvent({
      actor: actorRbac,
      action: 'admin.permissions_updated',
      targetResource: 'sub_user',
      targetId: subUserId,
      details: {
        updatedFields: Object.keys(updates),
        newPermissions: updates.permissions
      }
    });

    return updatedRecord;
  }

  /**
   * 5. Deactivate Sub-Admin (SUPER_ADMIN ONLY)
   */
  async deactivateSubAdmin(actorUser, subUserId) {
    const actorRbac = await this.getUserRoleAndPermissions(actorUser);
    if (actorRbac.role !== ROLES.SUPER_ADMIN) {
      throw {
        statusCode: 403,
        message: 'Forbidden: Only SUPER_ADMIN can deactivate administrator accounts.'
      };
    }

    const { data: rec, error: fetchErr } = await supabase
      .from('sub_users')
      .select('email')
      .eq('id', subUserId)
      .maybeSingle();

    if (fetchErr) {
      throw { statusCode: 500, message: `Database error finding sub-admin: ${fetchErr.message}` };
    }

    if (rec?.email && this.isSuperAdminEmail(rec.email)) {
      throw { statusCode: 403, message: 'Cannot deactivate the root Super Administrator account.' };
    }

    const { error: updateErr } = await supabase
      .from('sub_users')
      .update({ status: 'Disabled', updated_at: new Date().toISOString() })
      .eq('id', subUserId);

    if (updateErr) {
      throw { statusCode: 500, message: `Failed to deactivate sub-admin: ${updateErr.message}` };
    }

    // Audit Logging
    await this.logAuditEvent({
      actor: actorRbac,
      action: 'admin.deactivated',
      targetResource: 'sub_user',
      targetId: subUserId,
      details: { status: 'Disabled' }
    });

    return { status: 'SUCCESS', message: 'Sub-admin deactivated successfully.' };
  }

  /**
   * 5b. Delete Sub-Admin Permanently (SUPER_ADMIN ONLY)
   */
  async deleteSubAdmin(actorUser, subUserId) {
    const actorRbac = await this.getUserRoleAndPermissions(actorUser);
    if (actorRbac.role !== ROLES.SUPER_ADMIN) {
      throw {
        statusCode: 403,
        message: 'Forbidden: Only SUPER_ADMIN can delete administrator accounts.'
      };
    }

    const { data: rec, error: getErr } = await supabase
      .from('sub_users')
      .select('email')
      .eq('id', subUserId)
      .maybeSingle();

    if (getErr) {
      throw { statusCode: 500, message: `Database error finding sub-admin: ${getErr.message}` };
    }

    const targetEmail = rec?.email ? rec.email.toLowerCase().trim() : '';

    if (targetEmail && this.isSuperAdminEmail(targetEmail)) {
      throw { statusCode: 403, message: 'Cannot delete the root Super Administrator account.' };
    }

    const { error: delErr } = await supabase
      .from('sub_users')
      .delete()
      .eq('id', subUserId);

    if (delErr) {
      throw { statusCode: 500, message: `Failed to delete sub-admin from database: ${delErr.message}` };
    }

    if (targetEmail) {
      try {
        await supabase
          .from('sub_users')
          .delete()
          .ilike('email', targetEmail);

        const { data: listRes } = await supabase.auth.admin.listUsers();
        const authUser = (listRes?.users || []).find(u => u.email?.toLowerCase() === targetEmail);
        if (authUser?.id) {
          await supabase.auth.admin.deleteUser(authUser.id);
        }
      } catch (authDelErr) {
        console.warn('Notice deleting auth user for sub-admin:', authDelErr.message);
      }
    }

    // Audit Logging
    await this.logAuditEvent({
      actor: actorRbac,
      action: 'admin.deleted',
      targetResource: 'sub_user',
      targetId: subUserId,
      details: { deletedEmail: targetEmail }
    });

    return { status: 'SUCCESS', message: 'Sub-admin account deleted permanently.' };
  }

  /**
   * 6. List Sub-Admins
   * FAIL-CLOSED: Reads strictly from database. Zero in-memory store merging.
   */
  async listSubAdmins(actorUser) {
    const actorRbac = await this.getUserRoleAndPermissions(actorUser);
    if (!this.hasPermission(actorRbac, PERMISSIONS.ADMIN_VIEW)) {
      throw { statusCode: 403, message: 'Missing required permission: admin.view' };
    }

    const { data, error } = await supabase
      .from('sub_users')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ [RBAC] Database error listing sub-admins:', error.message);
      throw { statusCode: 500, message: `Failed to retrieve sub-admins from database: ${error.message}` };
    }

    return (data || []).map(sub => ({
      id: sub.id,
      name: sub.name,
      email: sub.email,
      designation: sub.designation,
      role: sub.role || ROLES.ADMIN,
      permissions: Array.isArray(sub.permissions) ? sub.permissions : [],
      status: sub.status || 'Active',
      createdAt: sub.created_at || new Date().toISOString()
    }));
  }

  /**
   * 7. Audit Logging Engine
   */
  async logAuditEvent({ actor, action, targetResource, targetId, details = {}, ip = null }) {
    const auditRecord = {
      actor_email: actor?.email || 'system',
      actor_role: actor?.role || 'SYSTEM',
      action: String(action),
      target_resource: targetResource || 'general',
      target_id: targetId ? String(targetId) : null,
      details: details || {},
      ip_address: ip,
      created_at: new Date().toISOString()
    };

    // Store in ring buffer (keeps last 500 records for display)
    memoryAuditLogStore.unshift(auditRecord);
    if (memoryAuditLogStore.length > 500) memoryAuditLogStore.pop();

    try {
      await supabase.from('audit_logs').insert([auditRecord]);
    } catch (e) {
      // Resilient logging fallback
    }

    console.log(`📝 [RBAC Audit Log] ${auditRecord.actor_email} (${auditRecord.actor_role}) executed '${auditRecord.action}' on ${auditRecord.target_resource}:${auditRecord.target_id || ''}`);
  }

  /**
   * 8. Fetch Audit Logs (SUPER_ADMIN ONLY)
   */
  async getAuditLogs(actorUser, { limit = 100 } = {}) {
    const actorRbac = await this.getUserRoleAndPermissions(actorUser);
    if (actorRbac.role !== ROLES.SUPER_ADMIN) {
      throw { statusCode: 403, message: 'Access Denied: Only SUPER_ADMIN can review system audit logs.' };
    }

    let records = [];
    try {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!error && Array.isArray(data)) {
        records = data;
      }
    } catch (e) {}

    if (records.length === 0) {
      records = memoryAuditLogStore.slice(0, limit);
    }

    return records;
  }
}

module.exports = new RbacService();
