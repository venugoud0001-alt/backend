/**
 * Role-Based Access Control (RBAC) & Audit Logging Service
 */

const { supabase } = require('../../config/supabase');
const { ROLES, PERMISSIONS } = require('./rbac.constants');
const env = require('../../config/env');

// Master Super Admin Email Whitelist
const SUPER_ADMIN_EMAILS = [
  'admin@internnetra.com',
  (env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim()
].filter(Boolean);

// In-Memory Resilient Cache for Sub-Users & Audit Trail
const memorySubUserStore = new Map();
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

    // 1. Check if SUPER_ADMIN
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

    // 2. Check if Delegated ADMIN (sub_users table)
    try {
      const { data: subUser, error } = await supabase
        .from('sub_users')
        .select('*')
        .ilike('email', email)
        .maybeSingle();

      if (!error && subUser) {
        // Sync with in-memory cache
        memorySubUserStore.set(email, subUser);

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
    } catch (e) {
      // Fall through to memory store if DB is connecting
    }

    // Check memory store for sub-users
    const cachedSub = memorySubUserStore.get(email);
    if (cachedSub) {
      if (cachedSub.status === 'Disabled') {
        return {
          userId: cachedSub.id,
          email,
          name: cachedSub.name,
          role: ROLES.ADMIN,
          permissions: [],
          isSuperAdmin: false,
          status: 'Disabled'
        };
      }

      return {
        userId: cachedSub.id,
        email,
        name: cachedSub.name,
        role: ROLES.ADMIN,
        permissions: cachedSub.permissions || [],
        isSuperAdmin: false,
        status: cachedSub.status || 'Active',
        designation: cachedSub.designation
      };
    }

    // 3. Fallback to STUDENT
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

    let createdRecord = null;
    try {
      const { data, error } = await supabase
        .from('sub_users')
        .insert([newSubUser])
        .select()
        .single();

      if (!error && data) {
        createdRecord = data;
      }
    } catch (e) {}

    if (!createdRecord) {
      createdRecord = {
        id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        ...newSubUser,
        created_at: new Date().toISOString()
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

    // Sync memory store
    memorySubUserStore.set(cleanEmail, createdRecord);

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

    let updatedRecord = null;
    try {
      const { data, error } = await supabase
        .from('sub_users')
        .update(updates)
        .eq('id', subUserId)
        .select()
        .single();

      if (!error && data) {
        updatedRecord = data;
        memorySubUserStore.set(data.email.toLowerCase().trim(), data);
      }
    } catch (e) {}

    if (!updatedRecord) {
      // Find in memory store
      for (const [k, v] of memorySubUserStore.entries()) {
        if (String(v.id) === String(subUserId)) {
          updatedRecord = { ...v, ...updates };
          memorySubUserStore.set(k, updatedRecord);
          break;
        }
      }
    }

    if (!updatedRecord) {
      throw { statusCode: 404, message: 'Sub-admin record not found.' };
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

    let targetEmail = '';
    for (const [k, v] of memorySubUserStore.entries()) {
      if (String(v.id) === String(subUserId)) {
        targetEmail = k;
        break;
      }
    }

    if (this.isSuperAdminEmail(targetEmail)) {
      throw { statusCode: 403, message: 'Cannot deactivate the root Super Administrator account.' };
    }

    try {
      await supabase
        .from('sub_users')
        .update({ status: 'Disabled', updated_at: new Date().toISOString() })
        .eq('id', subUserId);
    } catch (e) {}

    // Update memory
    for (const [k, v] of memorySubUserStore.entries()) {
      if (String(v.id) === String(subUserId)) {
        v.status = 'Disabled';
        memorySubUserStore.set(k, v);
        break;
      }
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

    let targetEmail = '';
    for (const [k, v] of memorySubUserStore.entries()) {
      if (String(v.id) === String(subUserId)) {
        targetEmail = k;
        break;
      }
    }

    if (!targetEmail) {
      try {
        const { data: rec } = await supabase
          .from('sub_users')
          .select('email')
          .eq('id', subUserId)
          .maybeSingle();
        if (rec?.email) targetEmail = rec.email;
      } catch (e) {}
    }

    if (targetEmail && this.isSuperAdminEmail(targetEmail)) {
      throw { statusCode: 403, message: 'Cannot delete the root Super Administrator account.' };
    }

    try {
      await supabase
        .from('sub_users')
        .delete()
        .eq('id', subUserId);

      if (targetEmail) {
        await supabase
          .from('sub_users')
          .delete()
          .ilike('email', targetEmail);

        try {
          const { data: listRes } = await supabase.auth.admin.listUsers();
          const authUser = (listRes?.users || []).find(u => u.email?.toLowerCase() === targetEmail.toLowerCase());
          if (authUser?.id) {
            await supabase.auth.admin.deleteUser(authUser.id);
          }
        } catch (authDelErr) {}
      }
    } catch (e) {}

    // Delete from memory store
    if (targetEmail) {
      memorySubUserStore.delete(targetEmail);
    }
    for (const [k, v] of memorySubUserStore.entries()) {
      if (String(v.id) === String(subUserId)) {
        memorySubUserStore.delete(k);
        break;
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
   */
  async listSubAdmins(actorUser) {
    const actorRbac = await this.getUserRoleAndPermissions(actorUser);
    if (!this.hasPermission(actorRbac, PERMISSIONS.ADMIN_VIEW)) {
      throw { statusCode: 403, message: 'Missing required permission: admin.view' };
    }

    let records = [];
    try {
      const { data, error } = await supabase
        .from('sub_users')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && Array.isArray(data)) {
        records = data;
      }
    } catch (e) {}

    // Merge with memory store
    const map = new Map();
    records.forEach(r => map.set(r.email.toLowerCase().trim(), r));
    for (const [k, v] of memorySubUserStore.entries()) {
      if (!map.has(k)) map.set(k, v);
    }

    return Array.from(map.values()).map(sub => ({
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

    // Store in ring buffer (keeps last 500 records)
    memoryAuditLogStore.unshift(auditRecord);
    if (memoryAuditLogStore.length > 500) memoryAuditLogStore.pop();

    try {
      await supabase.from('audit_logs').insert([auditRecord]);
    } catch (e) {
      // Resilient fallback
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
