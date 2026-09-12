-- =========================================================================
-- INTERNNETRA INSTALLMENT PAYMENT & TEMPORARY COURSE ACCESS CONTROL MIGRATION
-- Phase: Installment Payment Option, 5-Day Due Window, and Temporary Course Access Control
-- =========================================================================

-- 1. EXTEND ENROLLMENTS TABLE WITH INSTALLMENT & SUSPENSION TRACKING
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS first_installment_amount NUMERIC(12, 2);
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS second_installment_amount NUMERIC(12, 2);
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS first_installment_paid_at TIMESTAMPTZ;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS second_installment_paid_at TIMESTAMPTZ;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS second_payment_due_at TIMESTAMPTZ;

ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS suspension_reason VARCHAR(50); -- 'PAYMENT_OVERDUE' | 'MANUAL_ADMIN'
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS suspended_by UUID;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS suspension_notes TEXT;

ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS restored_by UUID;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS restoration_reason VARCHAR(50); -- 'PAYMENT_COMPLETED' | 'MANUAL_ADMIN'

-- Update course_access_status check constraint to include 'SUSPENDED' and 'UNLOCKED'
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS chk_enrollments_access_status_enum;
ALTER TABLE public.enrollments ADD CONSTRAINT chk_enrollments_access_status_enum 
  CHECK (course_access_status IN ('LOCKED', 'PARTIAL', 'ACTIVE', 'COMPLETED', 'SUSPENDED', 'UNLOCKED'));

-- Performance Indexes for Access Control & Overdue Sweeps
CREATE INDEX IF NOT EXISTS idx_enrollments_access_status ON public.enrollments(course_access_status);
CREATE INDEX IF NOT EXISTS idx_enrollments_second_due ON public.enrollments(second_payment_due_at) WHERE payment_plan = 'INSTALLMENT';
CREATE INDEX IF NOT EXISTS idx_enrollments_suspension ON public.enrollments(suspension_reason, suspended_at);

-- 2. CREATE IDEMPOTENT INSTALLMENT REMINDERS TABLE
CREATE TABLE IF NOT EXISTS public.installment_reminders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  enrollment_id UUID NOT NULL REFERENCES public.enrollments(id) ON DELETE CASCADE,
  student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
  reminder_type VARCHAR(50) NOT NULL, -- 'INSTALLMENT_PAYMENT_STARTED', 'INSTALLMENT_DUE_3_DAYS', 'INSTALLMENT_DUE_1_DAY', 'INSTALLMENT_DUE_TODAY', 'INSTALLMENT_PAYMENT_OVERDUE', 'COURSE_ACCESS_SUSPENDED', 'COURSE_ACCESS_RESTORED'
  due_date TIMESTAMPTZ,
  amount_due NUMERIC(12, 2),
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'SENT',
  channel VARCHAR(20) DEFAULT 'EMAIL',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_enrollment_reminder_type UNIQUE (enrollment_id, reminder_type)
);

CREATE INDEX IF NOT EXISTS idx_installment_reminders_enr ON public.installment_reminders(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_installment_reminders_type ON public.installment_reminders(reminder_type);

-- Enable RLS on installment_reminders
ALTER TABLE public.installment_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_installment_reminders ON public.installment_reminders;
CREATE POLICY service_role_installment_reminders ON public.installment_reminders USING (true) WITH CHECK (true);

-- 3. UPDATED ATOMIC STORED PROCEDURE: process_payment_webhook
-- Preserves all existing financial integrity, accounting invariants, idempotency, and batch reservations.
-- Adds: 5-day due window calculation, active access on 1st installment, automatic restoration
-- with strict priority guard (MANUAL_ADMIN suspension is never overridden by automated payment).
CREATE OR REPLACE FUNCTION process_payment_webhook(
  p_cashfree_order_id VARCHAR(255),
  p_cashfree_payment_id VARCHAR(255),
  p_student_name VARCHAR(255),
  p_email VARCHAR(255),
  p_amount_paid NUMERIC(12, 2)
) RETURNS JSONB AS $$
DECLARE
  v_existing_payment_id UUID;
  v_order RECORD;
  v_enrollment RECORD;
  v_total_fee NUMERIC(12, 2);
  v_current_paid NUMERIC(12, 2);
  v_new_amount_paid NUMERIC(12, 2);
  v_new_amount_pending NUMERIC(12, 2);
  v_is_full_payment BOOLEAN;
  v_new_payment_status VARCHAR(50);
  v_new_access_status VARCHAR(50);
  v_batch_id UUID;
  v_seat_incremented BOOLEAN := FALSE;
  v_first_paid_at TIMESTAMPTZ;
  v_second_paid_at TIMESTAMPTZ;
  v_second_due_at TIMESTAMPTZ;
  v_restored_at TIMESTAMPTZ;
  v_restoration_reason VARCHAR(50);
BEGIN
  -- 0. Amount Integrity Check
  IF p_amount_paid IS NULL OR p_amount_paid <= 0 THEN
    RETURN jsonb_build_object(
      'status', 'ERROR',
      'message', 'Payment amount must be greater than zero.'
    );
  END IF;

  -- 1. Idempotency Guard
  IF p_cashfree_payment_id IS NOT NULL THEN
    SELECT id INTO v_existing_payment_id
    FROM public.payments
    WHERE cashfree_payment_id = p_cashfree_payment_id;

    IF v_existing_payment_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'IDEMPOTENT',
        'message', 'Payment already processed and logged.',
        'payment_id', v_existing_payment_id
      );
    END IF;
  END IF;

  -- 2. Fetch Internal Order Row
  SELECT order_id, cashfree_order_id, student_id, course_id, enrollment_id, amount, status, installment_number INTO v_order
  FROM public.orders
  WHERE cashfree_order_id = p_cashfree_order_id;

  IF v_order.amount IS NOT NULL AND p_amount_paid < v_order.amount THEN
    RETURN jsonb_build_object(
      'status', 'ERROR',
      'message', 'Payment amount is less than expected authoritative order amount.'
    );
  END IF;

  -- 3. Lock and Fetch Target Enrollment Record FOR UPDATE
  IF v_order.enrollment_id IS NOT NULL THEN
    SELECT * INTO v_enrollment
    FROM public.enrollments
    WHERE id = v_order.enrollment_id
    FOR UPDATE;
  ELSE
    SELECT * INTO v_enrollment
    FROM public.enrollments
    WHERE LOWER(TRIM(student_id::text)) IN (SELECT id::text FROM public.students WHERE LOWER(TRIM(email)) = LOWER(TRIM(p_email)))
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF v_enrollment.id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'ERROR',
      'message', 'Enrollment record not found for webhook order.'
    );
  END IF;

  -- 4. Calculate Financials & Accounting Invariants
  v_total_fee := COALESCE(v_enrollment.total_amount, 4000.00);
  v_current_paid := COALESCE(v_enrollment.amount_paid, 0.00);
  v_new_amount_paid := v_current_paid + p_amount_paid;
  v_new_amount_pending := GREATEST(0.00, v_total_fee - v_new_amount_paid);
  v_is_full_payment := (v_new_amount_pending <= 0.00);
  v_new_payment_status := CASE WHEN v_is_full_payment THEN 'PAID' ELSE 'PARTIALLY_PAID' END;

  -- 5. Determine Access Status & Date Windows
  IF v_enrollment.payment_plan = 'INSTALLMENT' AND NOT v_is_full_payment THEN
    -- First installment paid: active access granted for 5 calendar days
    v_first_paid_at := COALESCE(v_enrollment.first_installment_paid_at, NOW());
    v_second_due_at := COALESCE(v_enrollment.second_payment_due_at, v_first_paid_at + INTERVAL '5 days');
    v_second_paid_at := v_enrollment.second_installment_paid_at;
    v_new_access_status := 'ACTIVE';
    v_restored_at := v_enrollment.restored_at;
    v_restoration_reason := v_enrollment.restoration_reason;
  ELSIF v_is_full_payment THEN
    -- Fully settled
    v_first_paid_at := COALESCE(v_enrollment.first_installment_paid_at, NOW());
    v_second_paid_at := NOW();
    v_second_due_at := v_enrollment.second_payment_due_at;

    -- ACCESS RESTORATION PRIORITY RULE:
    -- If manually suspended by admin (MANUAL_ADMIN), do NOT auto-restore!
    IF v_enrollment.course_access_status = 'SUSPENDED' AND v_enrollment.suspension_reason = 'MANUAL_ADMIN' THEN
      v_new_access_status := 'SUSPENDED'; -- Retain admin suspension
      v_restored_at := NULL;
      v_restoration_reason := NULL;
    ELSIF v_enrollment.course_access_status = 'SUSPENDED' AND v_enrollment.suspension_reason = 'PAYMENT_OVERDUE' THEN
      -- Auto-restore access!
      v_new_access_status := 'ACTIVE';
      v_restored_at := NOW();
      v_restoration_reason := 'PAYMENT_COMPLETED';
    ELSE
      v_new_access_status := 'ACTIVE';
      v_restored_at := v_enrollment.restored_at;
      v_restoration_reason := v_enrollment.restoration_reason;
    END IF;
  ELSE
    v_new_access_status := 'ACTIVE';
  END IF;

  -- 6. Insert Verified Payment Record
  BEGIN
    INSERT INTO public.payments (
      enrollment_id,
      student_id,
      student_name,
      email,
      course_name,
      txn_id,
      cashfree_order_id,
      cashfree_payment_id,
      amount,
      amount_paid,
      total_course_fee,
      remaining_balance,
      payment_type,
      payment_method,
      status
    ) VALUES (
      v_enrollment.id,
      v_enrollment.student_id,
      p_student_name,
      LOWER(TRIM(p_email)),
      v_enrollment.course_name,
      p_cashfree_payment_id,
      p_cashfree_order_id,
      p_cashfree_payment_id,
      p_amount_paid,
      p_amount_paid,
      v_total_fee,
      v_new_amount_pending,
      CASE WHEN v_is_full_payment THEN 'FULL' ELSE 'INSTALLMENT' END,
      'Cashfree PG',
      'SUCCESS'
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'status', 'IDEMPOTENT',
      'message', 'Concurrent webhook caught by database unique constraint.'
    );
  END;

  -- 7. Update Enrollment State Safely
  IF v_enrollment.payment_status != 'PAID' OR v_is_full_payment THEN
    UPDATE public.enrollments
    SET amount_paid = v_new_amount_paid,
        amount_pending = v_new_amount_pending,
        payment_status = v_new_payment_status,
        course_access_status = v_new_access_status,
        first_installment_paid_at = v_first_paid_at,
        second_installment_paid_at = v_second_paid_at,
        second_payment_due_at = v_second_due_at,
        installment_due_at = COALESCE(v_second_due_at, v_enrollment.installment_due_at),
        restored_at = COALESCE(v_restored_at, v_enrollment.restored_at),
        restoration_reason = COALESCE(v_restoration_reason, v_enrollment.restoration_reason),
        suspension_reason = CASE WHEN v_new_access_status = 'ACTIVE' THEN NULL ELSE v_enrollment.suspension_reason END,
        updated_at = NOW()
    WHERE id = v_enrollment.id;
  END IF;

  -- 8. Update Order Status
  IF v_order.order_id IS NOT NULL THEN
    UPDATE public.orders
    SET status = 'PAID'
    WHERE order_id = v_order.order_id;
  END IF;

  -- 9. Atomically Reserve Batch Seat if batch_id is bound
  v_batch_id := v_enrollment.batch_id;
  IF v_batch_id IS NOT NULL THEN
    v_seat_incremented := increment_batch_enrolled_count(v_batch_id);
  END IF;

  RETURN jsonb_build_object(
    'status', 'SUCCESS',
    'enrollment_id', v_enrollment.id,
    'payment_status', v_new_payment_status,
    'course_access_status', v_new_access_status,
    'first_paid_at', v_first_paid_at,
    'second_due_at', v_second_due_at,
    'second_paid_at', v_second_paid_at,
    'batch_seat_incremented', v_seat_incremented
  );
END;
$$ LANGUAGE plpgsql;
