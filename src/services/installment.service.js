/**
 * Enterprise Installment Payment, Due Window & Temporary Access Control Service
 * 
 * Rules:
 * 1. 5-day calendar due window: second_payment_due_at = first_installment_paid_at + 5 calendar days.
 * 2. Active access during 5-day window: Access is ACTIVE upon first installment.
 * 3. Automatic suspension: If second installment is unpaid after 5 days, course_access_status = 'SUSPENDED' (PAYMENT_OVERDUE).
 * 4. Priority Rule: MANUAL_ADMIN suspension takes absolute precedence over automated payment restoration.
 * 5. Idempotent background sweep and notification tracking.
 */

const { supabase } = require('../config/supabase');
const mailer = require('../../services/mailer');
const logger = console;

// In-memory set to prevent concurrent sweeps
let isSweepInProgress = false;
let sweepSchedulerTimer = null;

// Track dispatched reminder notifications in-memory fallback if table not yet migrated
const dispatchedRemindersFallback = new Set();

/**
 * Calculate 5 calendar days due date from a reference date
 */
function calculateSecondPaymentDueDate(fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + 5);
  return d;
}

/**
 * Calculate days remaining or overdue from a due date
 */
function calculateDueDiff(dueDateStr) {
  if (!dueDateStr) return { daysRemaining: 0, daysOverdue: 0, isOverdue: false };
  const due = new Date(dueDateStr).getTime();
  const now = Date.now();
  const diffMs = due - now;
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return {
      daysRemaining: 0,
      daysOverdue: Math.abs(diffDays),
      isOverdue: true
    };
  }

  return {
    daysRemaining: diffDays,
    daysOverdue: 0,
    isOverdue: false
  };
}

class InstallmentService {
  /**
   * Authoritative calculation: 5 calendar days due date from first payment date
   */
  calculateSecondPaymentDueDate(fromDate = new Date()) {
    return calculateSecondPaymentDueDate(fromDate);
  }

  /**
   * Log an audit event into public.audit_logs
   */
  async logAuditEvent({ actorEmail = 'system@internnetra.com', actorRole = 'SYSTEM', action, targetId, details = {} }) {
    try {
      await supabase.from('audit_logs').insert([{
        actor_email: actorEmail,
        actor_role: actorRole,
        action,
        target_resource: 'enrollment',
        target_id: String(targetId),
        details,
        created_at: new Date().toISOString()
      }]);
    } catch (err) {
      logger.warn('[InstallmentService] Audit log write note:', err.message);
    }
  }

  /**
   * Check if a reminder was already sent (Idempotency check)
   */
  async wasReminderSent(enrollmentId, reminderType) {
    const memKey = `${enrollmentId}_${reminderType}`;
    if (dispatchedRemindersFallback.has(memKey)) return true;

    try {
      const { data, error } = await supabase
        .from('installment_reminders')
        .select('id')
        .eq('enrollment_id', enrollmentId)
        .eq('reminder_type', reminderType)
        .maybeSingle();

      if (!error && data) {
        dispatchedRemindersFallback.add(memKey);
        return true;
      }
    } catch (err) {
      // Table may not exist yet, fallback to audit_logs check
    }

    try {
      const { data: auditData } = await supabase
        .from('audit_logs')
        .select('id')
        .eq('target_id', enrollmentId)
        .eq('action', reminderType)
        .limit(1)
        .maybeSingle();

      if (auditData) {
        dispatchedRemindersFallback.add(memKey);
        return true;
      }
    } catch (auditErr) {
      // ignore
    }

    return false;
  }

  /**
   * Record a dispatched reminder
   */
  async recordReminderSent(enrollmentId, studentId, reminderType, dueDate, amountDue, metadata = {}) {
    const memKey = `${enrollmentId}_${reminderType}`;
    dispatchedRemindersFallback.add(memKey);

    try {
      await supabase.from('installment_reminders').insert([{
        enrollment_id: enrollmentId,
        student_id: studentId || null,
        reminder_type: reminderType,
        due_date: dueDate || null,
        amount_due: amountDue || 0,
        status: 'SENT',
        channel: 'EMAIL',
        metadata,
        sent_at: new Date().toISOString()
      }]);
    } catch (err) {
      // Table might not exist yet
    }

    await this.logAuditEvent({
      action: reminderType,
      targetId: enrollmentId,
      details: { student_id: studentId, due_date: dueDate, amount_due: amountDue, ...metadata }
    });
  }

  /**
   * Determine exact installment and access state for an enrollment
   */
  evaluateEnrollmentState(enrollment) {
    if (!enrollment) return null;

    const total = Number(enrollment.total_amount || 0);
    const paid = Number(enrollment.amount_paid || 0);
    const pending = Number(enrollment.amount_pending ?? (total - paid));
    const isPlanInstallment = (enrollment.payment_plan || '').toUpperCase() === 'INSTALLMENT';
    const isSettled = (enrollment.payment_status || '').toUpperCase() === 'PAID' || pending <= 0;

    const firstPaidAt = enrollment.first_installment_paid_at || (paid > 0 ? enrollment.created_at : null);
    let secondDueAt = enrollment.second_payment_due_at || enrollment.installment_due_at;

    if (!secondDueAt && firstPaidAt && isPlanInstallment && !isSettled) {
      secondDueAt = calculateSecondPaymentDueDate(firstPaidAt).toISOString();
    }

    const { daysRemaining, daysOverdue, isOverdue } = calculateDueDiff(secondDueAt);

    let paymentState = 'FULLY_PAID';
    if (!isSettled) {
      if (paid === 0) {
        paymentState = 'INSTALLMENT_PENDING';
      } else if (isOverdue) {
        paymentState = 'OVERDUE';
      } else if (daysRemaining <= 2) {
        paymentState = 'DUE_SOON';
      } else {
        paymentState = 'FIRST_INSTALLMENT_PAID';
      }
    }

    const isAccessSuspended = enrollment.course_access_status === 'SUSPENDED';
    const suspensionReason = enrollment.suspension_reason || (isAccessSuspended ? 'PAYMENT_OVERDUE' : null);

    return {
      enrollmentId: enrollment.id,
      courseId: enrollment.course_id,
      courseName: enrollment.course_name,
      studentId: enrollment.student_id,
      paymentPlan: enrollment.payment_plan,
      paymentStatus: enrollment.payment_status,
      paymentState,
      totalAmount: total,
      amountPaid: paid,
      amountPending: pending,
      firstInstallmentPaidAt: firstPaidAt,
      secondPaymentDueAt: secondDueAt,
      daysRemaining,
      daysOverdue,
      isOverdue,
      courseAccessStatus: enrollment.course_access_status || 'ACTIVE',
      isSuspended: isAccessSuspended,
      suspensionReason,
      suspendedAt: enrollment.suspended_at,
      suspendedBy: enrollment.suspended_by,
      restoredAt: enrollment.restored_at,
      restoredBy: enrollment.restored_by,
      restorationReason: enrollment.restoration_reason
    };
  }

  /**
   * Idempotent sweep of overdue installment payments
   * Identifies enrollments where due date has elapsed and access is still ACTIVE
   */
  async sweepOverdueInstallments() {
    if (isSweepInProgress) {
      logger.log('ℹ️ [Installment Sweeper] Sweep already in progress, skipping concurrent run.');
      return { skipped: true };
    }

    isSweepInProgress = true;
    const stats = { checked: 0, suspended: 0, restored: 0, remindersSent: 0, errors: 0 };

    try {
      const now = new Date();
      logger.log(`⏰ [Installment Sweeper] Running overdue check at ${now.toISOString()}...`);

      // 1. Fetch active installment enrollments with pending balance
      const { data: enrollments, error } = await supabase
        .from('enrollments')
        .select('*')
        .eq('payment_plan', 'INSTALLMENT')
        .neq('payment_status', 'PAID');

      if (error) {
        throw error;
      }

      if (!enrollments || enrollments.length === 0) {
        logger.log('ℹ️ [Installment Sweeper] No pending installment enrollments found.');
        return stats;
      }

      for (const enr of enrollments) {
        stats.checked++;
        try {
          const total = Number(enr.total_amount || 0);
          const paid = Number(enr.amount_paid || 0);
          const pending = Number(enr.amount_pending ?? (total - paid));

          // If student somehow paid fully, mark settled
          if (pending <= 0) {
            continue;
          }

          // Must have made first installment to be in the 5-day completion window
          if (paid <= 0) {
            continue;
          }

          // Determine authoritative due date (5 calendar days from first payment)
          const firstPaidAt = enr.first_installment_paid_at || enr.created_at;
          let dueAt = enr.second_payment_due_at || enr.installment_due_at;

          if (!dueAt && firstPaidAt) {
            dueAt = calculateSecondPaymentDueDate(firstPaidAt).toISOString();
            // Resiliently persist the computed due date so it remains stable
            try {
              await supabase.from('enrollments').update({
                installment_due_at: dueAt,
                second_payment_due_at: dueAt,
                first_installment_paid_at: firstPaidAt
              }).eq('id', enr.id);
            } catch (uErr) {
              // ignore
            }
          }

          if (!dueAt) continue;

          const dueDate = new Date(dueAt);
          const isOverdue = now.getTime() > dueDate.getTime();
          const { daysRemaining } = calculateDueDiff(dueAt);

          // CASE A: OVERDUE AND CURRENTLY ACTIVE -> SUSPEND TEMPORARILY
          if (isOverdue && enr.course_access_status !== 'SUSPENDED') {
            logger.log(`⚠️ [Installment Sweeper] Suspending course access for enrollment ${enr.id} (${enr.course_name}). Overdue since ${dueAt}.`);

            const updatePayload = {
              course_access_status: 'SUSPENDED',
              suspension_reason: 'PAYMENT_OVERDUE',
              suspended_at: now.toISOString(),
              updated_at: now.toISOString()
            };

            // Attempt update including new columns; fallback to course_access_status if columns absent
            let { error: updateErr } = await supabase
              .from('enrollments')
              .update(updatePayload)
              .eq('id', enr.id)
              .neq('course_access_status', 'SUSPENDED');

            if (updateErr) {
              // Fallback update
              await supabase
                .from('enrollments')
                .update({ course_access_status: 'SUSPENDED', updated_at: now.toISOString() })
                .eq('id', enr.id);
            }

            stats.suspended++;

            // Audit log
            await this.logAuditEvent({
              action: 'AUTO_ACCESS_SUSPENDED',
              targetId: enr.id,
              details: {
                student_id: enr.student_id,
                course_id: enr.course_id,
                course_name: enr.course_name,
                total_amount: total,
                amount_paid: paid,
                amount_pending: pending,
                due_date: dueAt,
                reason: 'PAYMENT_OVERDUE'
              }
            });

            // Dispatch notification (Idempotent)
            const wasSent = await this.wasReminderSent(enr.id, 'COURSE_ACCESS_SUSPENDED');
            if (!wasSent) {
              // Find student email
              const { data: student } = await supabase.from('students').select('email, full_name').eq('id', enr.student_id).maybeSingle();
              const studentEmail = student?.email || enr.student_id;

              if (studentEmail && String(studentEmail).includes('@')) {
                try {
                  await mailer.transporter.sendMail({
                    from: process.env.SMTP_FROM || `"InternNetra Portal" <${process.env.SMTP_USER || "info@internnetra.com"}>`,
                    to: studentEmail,
                    subject: `⚠️ Temporary Course Access Suspension - ${enr.course_name || 'InternNetra'}`,
                    html: `
                      <div style="font-family: Arial, sans-serif; padding: 24px; color: #1e293b;">
                        <h2 style="color: #b91c1c;">Course Access Temporarily Suspended</h2>
                        <p>Dear ${student?.full_name || 'Student'},</p>
                        <p>Your access to <strong>${enr.course_name}</strong> has been temporarily suspended because the remaining 2nd installment payment is overdue.</p>
                        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 16px; border-radius: 12px; margin: 16px 0;">
                          <p style="margin: 4px 0;"><strong>First Installment:</strong> PAID (₹${paid.toLocaleString('en-IN')})</p>
                          <p style="margin: 4px 0;"><strong>Remaining Balance:</strong> ₹${pending.toLocaleString('en-IN')}</p>
                          <p style="margin: 4px 0;"><strong>Original Due Date:</strong> ${dueDate.toLocaleDateString('en-IN')}</p>
                        </div>
                        <p>Your progress, completed lessons, and certificates are safely preserved. Please complete your remaining payment to instantly restore full course access.</p>
                        <a href="https://internnetra.com/dashboard" style="display: inline-block; background: #00458A; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin-top: 12px;">Pay Remaining Installment</a>
                      </div>
                    `
                  });
                  await this.recordReminderSent(enr.id, enr.student_id, 'COURSE_ACCESS_SUSPENDED', dueAt, pending);
                  stats.remindersSent++;
                } catch (mailErr) {
                  logger.warn('Email dispatch warning for suspension:', mailErr.message);
                }
              }
            }
          }

          // CASE B: UPCOMING DUE REMINDERS (3 days, 1 day, due today)
          if (!isOverdue && enr.course_access_status !== 'SUSPENDED') {
            let reminderType = null;
            if (daysRemaining === 3) {
              reminderType = 'INSTALLMENT_DUE_3_DAYS';
            } else if (daysRemaining === 1) {
              reminderType = 'INSTALLMENT_DUE_1_DAY';
            } else if (daysRemaining === 0) {
              reminderType = 'INSTALLMENT_DUE_TODAY';
            }

            if (reminderType) {
              const alreadyNotified = await this.wasReminderSent(enr.id, reminderType);
              if (!alreadyNotified) {
                const { data: student } = await supabase.from('students').select('email, full_name').eq('id', enr.student_id).maybeSingle();
                const studentEmail = student?.email;

                if (studentEmail && String(studentEmail).includes('@')) {
                  try {
                    await mailer.transporter.sendMail({
                      from: process.env.SMTP_FROM || `"InternNetra Portal" <${process.env.SMTP_USER || "info@internnetra.com"}>`,
                      to: studentEmail,
                      subject: `Reminder: 2nd Installment Due (${daysRemaining === 0 ? 'Today' : `in ${daysRemaining} Day${daysRemaining > 1 ? 's' : ''}`}) - ${enr.course_name}`,
                      html: `
                        <div style="font-family: Arial, sans-serif; padding: 24px; color: #1e293b;">
                          <h2 style="color: #00458A;">Installment Payment Reminder</h2>
                          <p>Dear ${student?.full_name || 'Student'},</p>
                          <p>This is a friendly reminder that the remaining 2nd installment for <strong>${enr.course_name}</strong> is due <strong>${daysRemaining === 0 ? 'today' : `in ${daysRemaining} day${daysRemaining > 1 ? 's' : ''}`}</strong> (${dueDate.toLocaleDateString('en-IN')}).</p>
                          <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 16px; border-radius: 12px; margin: 16px 0;">
                            <p style="margin: 4px 0;"><strong>Remaining Amount Due:</strong> ₹${pending.toLocaleString('en-IN')}</p>
                            <p style="margin: 4px 0;"><strong>Due Date:</strong> ${dueDate.toLocaleDateString('en-IN')}</p>
                          </div>
                          <p>Please complete your payment before the deadline to ensure uninterrupted access to your learning materials.</p>
                          <a href="https://internnetra.com/dashboard" style="display: inline-block; background: #00458A; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin-top: 12px;">Pay ₹${pending.toLocaleString('en-IN')} Now</a>
                        </div>
                      `
                    });
                    await this.recordReminderSent(enr.id, enr.student_id, reminderType, dueAt, pending);
                    stats.remindersSent++;
                  } catch (mailErr) {
                    logger.warn(`Reminder dispatch warning (${reminderType}):`, mailErr.message);
                  }
                }
              }
            }
          }
        } catch (enrErr) {
          stats.errors++;
          logger.warn(`[Installment Sweeper] Error processing enrollment ${enr.id}:`, enrErr.message);
        }
      }

      logger.log(`✅ [Installment Sweeper] Sweep complete. Checked: ${stats.checked}, Suspended: ${stats.suspended}, Reminders: ${stats.remindersSent}, Errors: ${stats.errors}`);
      return stats;
    } catch (err) {
      logger.error('❌ [Installment Sweeper] Sweep failure:', err);
      return { error: err.message };
    } finally {
      isSweepInProgress = false;
    }
  }

  /**
   * Handle payment settlement with strict Priority-based Course Access Restoration
   * Invariant: MANUAL_ADMIN suspension is NEVER overridden by automatic payment completion.
   */
  async handlePaymentSettlement({ enrollmentId, amountPaid, txnId, isWebhook = false }) {
    if (!enrollmentId) return null;

    try {
      const { data: enrollment, error } = await supabase
        .from('enrollments')
        .select('*')
        .eq('id', enrollmentId)
        .maybeSingle();

      if (error || !enrollment) {
        logger.warn('[InstallmentService] handlePaymentSettlement: Enrollment not found:', enrollmentId);
        return null;
      }

      const totalFee = Number(enrollment.total_amount || 0);
      const currentPaid = Number(enrollment.amount_paid || 0);
      const newPaid = Math.min(totalFee, currentPaid + (Number(amountPaid) || 0));
      const newPending = Math.max(0, totalFee - newPaid);
      const isFullySettled = newPending <= 0;

      const nowIso = new Date().toISOString();
      let newAccessStatus = enrollment.course_access_status;
      let restoredAt = null;
      let restorationReason = null;

      // FIRST INSTALLMENT COMPLETION
      if (!isFullySettled && currentPaid === 0 && newPaid > 0) {
        const dueAt = calculateSecondPaymentDueDate().toISOString();
        newAccessStatus = 'ACTIVE';

        const updateData = {
          payment_status: 'PARTIALLY_PAID',
          amount_paid: newPaid,
          amount_pending: newPending,
          course_access_status: 'ACTIVE',
          first_installment_paid_at: nowIso,
          second_payment_due_at: dueAt,
          installment_due_at: dueAt,
          suspension_reason: null,
          updated_at: nowIso
        };

        try {
          await supabase.from('enrollments').update(updateData).eq('id', enrollmentId);
        } catch (uErr) {
          await supabase.from('enrollments').update({
            payment_status: 'PARTIALLY_PAID',
            amount_paid: newPaid,
            amount_pending: newPending,
            course_access_status: 'ACTIVE',
            installment_due_at: dueAt,
            updated_at: nowIso
          }).eq('id', enrollmentId);
        }

        await this.logAuditEvent({
          action: 'FIRST_INSTALLMENT_PAID',
          targetId: enrollmentId,
          details: { amount_paid: newPaid, amount_pending: newPending, due_at: dueAt, txn_id: txnId }
        });

        await this.recordReminderSent(enrollmentId, enrollment.student_id, 'INSTALLMENT_PAYMENT_STARTED', dueAt, newPending);
        return { status: 'FIRST_INSTALLMENT_SETTLED', dueAt, newPending };
      }

      // SECOND / FINAL INSTALLMENT COMPLETION
      if (isFullySettled) {
        // Evaluate Priority Rule:
        // Priority 1: MANUAL_ADMIN suspension -> Must NOT be automatically restored!
        // Priority 2: PAYMENT_OVERDUE suspension -> Restore to ACTIVE automatically!
        // Priority 3: Already ACTIVE -> Remain ACTIVE!

        const wasSuspendedByAdmin = (enrollment.suspension_reason === 'MANUAL_ADMIN') ||
          (enrollment.course_access_status === 'SUSPENDED' && enrollment.suspension_reason === 'MANUAL_ADMIN');

        if (wasSuspendedByAdmin) {
          logger.warn(`🛑 [Priority Rule Guard] Enrollment ${enrollmentId} was manually suspended by ADMIN. Payment is now FULLY PAID, but access remains SUSPENDED until admin manual restoration.`);
          newAccessStatus = 'SUSPENDED'; // RETAIN MANUAL SUSPENSION
          restoredAt = null;
          restorationReason = null;
        } else if (enrollment.course_access_status === 'SUSPENDED') {
          // Automatic restoration for payment overdue
          newAccessStatus = 'ACTIVE';
          restoredAt = nowIso;
          restorationReason = 'PAYMENT_COMPLETED';
          logger.log(`🎉 [Auto Restore] Enrollment ${enrollmentId} was suspended for PAYMENT_OVERDUE. Restoring access to ACTIVE.`);
        } else {
          newAccessStatus = 'ACTIVE';
        }

        const updateData = {
          payment_status: 'PAID',
          amount_paid: totalFee,
          amount_pending: 0,
          course_access_status: newAccessStatus,
          second_installment_paid_at: nowIso,
          restored_at: restoredAt,
          restoration_reason: restorationReason,
          updated_at: nowIso
        };

        if (newAccessStatus === 'ACTIVE') {
          updateData.suspension_reason = null;
        }

        try {
          await supabase.from('enrollments').update(updateData).eq('id', enrollmentId);
        } catch (uErr) {
          await supabase.from('enrollments').update({
            payment_status: 'PAID',
            amount_paid: totalFee,
            amount_pending: 0,
            course_access_status: newAccessStatus,
            updated_at: nowIso
          }).eq('id', enrollmentId);
        }

        await this.logAuditEvent({
          action: 'SECOND_INSTALLMENT_PAID',
          targetId: enrollmentId,
          details: {
            total_fee: totalFee,
            final_payment: amountPaid,
            access_status: newAccessStatus,
            was_admin_suspended: wasSuspendedByAdmin,
            txn_id: txnId
          }
        });

        if (restoredAt) {
          await this.logAuditEvent({
            action: 'AUTO_ACCESS_RESTORED',
            targetId: enrollmentId,
            details: { reason: 'PAYMENT_COMPLETED', restored_at: restoredAt }
          });
          await this.recordReminderSent(enrollmentId, enrollment.student_id, 'COURSE_ACCESS_RESTORED', null, 0);
        }

        return { status: 'FULLY_PAID', accessStatus: newAccessStatus, restored: Boolean(restoredAt) };
      }
    } catch (err) {
      logger.error('[InstallmentService] handlePaymentSettlement error:', err);
      return null;
    }
  }

  /**
   * Admin Manual Suspension of Course Access
   */
  async manualSuspendAccess({ enrollmentId, adminEmail = 'admin@internnetra.com', adminId = null, reason = 'MANUAL_ADMIN', notes = '' }) {
    if (!enrollmentId) throw new Error('enrollmentId is required.');

    const nowIso = new Date().toISOString();
    const finalReason = reason && reason !== 'PAYMENT_OVERDUE' ? reason : 'MANUAL_ADMIN';
    const updatePayload = {
      course_access_status: 'SUSPENDED',
      suspension_reason: finalReason,
      suspended_at: nowIso,
      suspended_by: adminId,
      suspension_notes: notes || (finalReason === 'CONDUCT' ? 'Academic or conduct review hold.' : 'Suspended manually by administrator.'),
      updated_at: nowIso
    };

    let { data, error } = await supabase
      .from('enrollments')
      .update(updatePayload)
      .eq('id', enrollmentId)
      .select()
      .single();

    if (error) {
      // Fallback in case columns not in schema yet
      const fallback = await supabase
        .from('enrollments')
        .update({ course_access_status: 'SUSPENDED', updated_at: nowIso })
        .eq('id', enrollmentId)
        .select()
        .single();
      if (fallback.error) throw fallback.error;
      data = fallback.data;
    }

    await this.logAuditEvent({
      actorEmail: adminEmail,
      actorRole: 'ADMIN',
      action: 'MANUAL_ACCESS_SUSPENDED',
      targetId: enrollmentId,
      details: {
        admin_id: adminId,
        reason: 'MANUAL_ADMIN',
        notes,
        suspended_at: nowIso
      }
    });

    return data;
  }

  /**
   * Admin Manual Restoration of Course Access
   */
  async manualRestoreAccess({ enrollmentId, adminEmail = 'admin@internnetra.com', adminId = null, reason = 'MANUAL_ADMIN', notes = '' }) {
    if (!enrollmentId) throw new Error('enrollmentId is required.');

    const nowIso = new Date().toISOString();
    const updatePayload = {
      course_access_status: 'ACTIVE',
      suspension_reason: null,
      restored_at: nowIso,
      restored_by: adminId,
      restoration_reason: 'MANUAL_ADMIN',
      updated_at: nowIso
    };

    let { data, error } = await supabase
      .from('enrollments')
      .update(updatePayload)
      .eq('id', enrollmentId)
      .select()
      .single();

    if (error) {
      // Fallback
      const fallback = await supabase
        .from('enrollments')
        .update({ course_access_status: 'ACTIVE', updated_at: nowIso })
        .eq('id', enrollmentId)
        .select()
        .single();
      if (fallback.error) throw fallback.error;
      data = fallback.data;
    }

    await this.logAuditEvent({
      actorEmail: adminEmail,
      actorRole: 'ADMIN',
      action: 'MANUAL_ACCESS_RESTORED',
      targetId: enrollmentId,
      details: {
        admin_id: adminId,
        reason: 'MANUAL_ADMIN',
        notes,
        restored_at: nowIso
      }
    });

    return data;
  }

  /**
   * Fetch complete Installment & Access Control Ledger for Admin UI
   */
  async getAdminInstallmentLedger() {
    const { data: enrollments, error } = await supabase
      .from('enrollments')
      .select('*, students(id, full_name, email, phone)')
      .order('updated_at', { ascending: false });

    if (error) throw error;

    return (enrollments || []).map(enr => {
      const state = this.evaluateEnrollmentState(enr);
      const student = enr.students || {};
      return {
        ...state,
        studentName: student.full_name || 'Student',
        studentEmail: student.email || '',
        studentPhone: student.phone || '',
        rawEnrollment: enr
      };
    });
  }

  /**
   * Start Scheduled Background Maintenance Worker
   * Integrates into existing Node server scheduler without spawning external daemons
   */
  startScheduledMaintenance({ intervalMinutes = 30 } = {}) {
    if (sweepSchedulerTimer) {
      clearInterval(sweepSchedulerTimer);
    }

    const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000;
    logger.log(`⏰ [Installment Scheduler] Started periodic overdue & reminder sweep every ${intervalMinutes} minutes.`);

    // Run initial sweep after 10s delay to allow server startup
    setTimeout(() => {
      this.sweepOverdueInstallments().catch(err => {
        logger.warn('⚠️ [Installment Sweeper Initial Run Note]:', err.message);
      });
    }, 10000);

    // Schedule recurring sweeps
    sweepSchedulerTimer = setInterval(() => {
      this.sweepOverdueInstallments().catch(err => {
        logger.warn('⚠️ [Installment Sweeper Interval Run Note]:', err.message);
      });
    }, intervalMs);
  }
}

module.exports = new InstallmentService();
