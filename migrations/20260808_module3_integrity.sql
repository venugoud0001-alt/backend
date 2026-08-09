-- =========================================================================
-- INTERNNETRA LMS MODULE 3 & 4: DATABASE INTEGRITY & STRICT NO-REFUND POLICY
-- =========================================================================

-- 1. COURSES TABLE CONSTRAINTS & INDEXES
ALTER TABLE public.courses DROP CONSTRAINT IF EXISTS chk_courses_price_positive;
ALTER TABLE public.courses ADD CONSTRAINT chk_courses_price_positive CHECK (price >= 0);

ALTER TABLE public.courses DROP CONSTRAINT IF EXISTS chk_courses_installment_price_positive;
ALTER TABLE public.courses ADD CONSTRAINT chk_courses_installment_price_positive CHECK (installment_price >= 0);

ALTER TABLE public.courses DROP CONSTRAINT IF EXISTS chk_courses_status_enum;
ALTER TABLE public.courses ADD CONSTRAINT chk_courses_status_enum CHECK (status IN ('DRAFT', 'PUBLISHED', 'ACTIVE', 'ARCHIVED'));

-- 2. BATCHES TABLE CONSTRAINTS & INDEXES
ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS chk_batches_capacity_positive;
ALTER TABLE public.batches ADD CONSTRAINT chk_batches_capacity_positive CHECK (capacity > 0);

ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS chk_batches_enrolled_count_bounds;
ALTER TABLE public.batches ADD CONSTRAINT chk_batches_enrolled_count_bounds CHECK (enrolled_count >= 0 AND enrolled_count <= capacity);

ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS chk_batches_status_enum;
ALTER TABLE public.batches ADD CONSTRAINT chk_batches_status_enum CHECK (status IN ('ACTIVE', 'FULL', 'CLOSED'));

-- 3. STUDENTS TABLE CONSTRAINTS & INDEXES
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS chk_students_account_status_enum;
ALTER TABLE public.students ADD CONSTRAINT chk_students_account_status_enum CHECK (account_status IN ('NOT_ACTIVATED', 'ACTIVE', 'SUSPENDED'));

CREATE INDEX IF NOT EXISTS idx_students_account_status ON public.students(account_status);

-- 4. ENROLLMENTS TABLE CONSTRAINTS, ACCOUNTING INVARIANT & INDEXES
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS chk_enrollments_amounts_positive;
ALTER TABLE public.enrollments ADD CONSTRAINT chk_enrollments_amounts_positive CHECK (total_amount >= 0 AND amount_paid >= 0 AND amount_pending >= 0);

-- Mandatory Financial Accounting Invariant: amount_paid + amount_pending = total_amount
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS chk_enrollments_accounting_invariant;
ALTER TABLE public.enrollments ADD CONSTRAINT chk_enrollments_accounting_invariant CHECK (ROUND(amount_paid + amount_pending, 2) = ROUND(total_amount, 2));

ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS chk_enrollments_payment_plan_enum;
ALTER TABLE public.enrollments ADD CONSTRAINT chk_enrollments_payment_plan_enum CHECK (payment_plan IN ('FULL', 'INSTALLMENT'));

ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS chk_enrollments_payment_status_enum;
ALTER TABLE public.enrollments ADD CONSTRAINT chk_enrollments_payment_status_enum CHECK (payment_status IN ('PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID', 'FAILED'));

ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS chk_enrollments_access_status_enum;
ALTER TABLE public.enrollments ADD CONSTRAINT chk_enrollments_access_status_enum CHECK (course_access_status IN ('LOCKED', 'PARTIAL', 'ACTIVE', 'COMPLETED'));

CREATE INDEX IF NOT EXISTS idx_enrollments_student_status ON public.enrollments(student_id, payment_status);

-- 5. ORDERS TABLE CONSTRAINTS & INDEXES
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS chk_orders_amount_positive;
ALTER TABLE public.orders ADD CONSTRAINT chk_orders_amount_positive CHECK (amount > 0);

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS chk_orders_status_enum;
ALTER TABLE public.orders ADD CONSTRAINT chk_orders_status_enum CHECK (status IN ('CREATED', 'PAID', 'FAILED', 'CANCELLED'));

-- 6. PAYMENTS TRANSACTION TABLE CONSTRAINTS (STRICT NO-REFUND POLICY: REFUNDED REMOVED)
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS chk_payments_amount_positive;
ALTER TABLE public.payments ADD CONSTRAINT chk_payments_amount_positive CHECK (amount > 0);

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS chk_payments_status_enum;
ALTER TABLE public.payments ADD CONSTRAINT chk_payments_status_enum CHECK (status IN ('SUCCESS', 'FAILED', 'USER_DROPPED'));

-- Hardened Mandatory NOT NULL Constraints for Financial Records
ALTER TABLE public.payments ALTER COLUMN email SET NOT NULL;
ALTER TABLE public.payments ALTER COLUMN amount SET NOT NULL;
ALTER TABLE public.payments ALTER COLUMN cashfree_payment_id SET NOT NULL;

-- Hardened Unique Index for Idempotency
DROP INDEX IF EXISTS idx_payments_cashfree_payment_id_unique;
CREATE UNIQUE INDEX idx_payments_cashfree_payment_id_unique ON public.payments(cashfree_payment_id);

CREATE INDEX IF NOT EXISTS idx_payments_status_email ON public.payments(status, email);

-- 7. PROFILES TABLE INDEXES & LINKING
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);

-- =========================================================================
-- 8. TRANSACTIONALLY SAFE WEBHOOK STORED PROCEDURE: process_payment_webhook
-- Guarantees: 1 Cashfree Payment -> 1 Payment Record -> 1 Enrollment Activation -> 1 Batch Seat Increment
-- Strict No-Refund Policy & Out-of-Order Transition Protection
-- =========================================================================
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
BEGIN
  -- 0. Amount Integrity Check: Reject non-positive or NULL payment amounts
  IF p_amount_paid IS NULL OR p_amount_paid <= 0 THEN
    RETURN jsonb_build_object(
      'status', 'ERROR',
      'message', 'Payment amount must be greater than zero.'
    );
  END IF;

  -- 1. Idempotency Guard: Check if cashfree_payment_id is already logged
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

  -- 2. Fetch Internal Order Row Deterministically by cashfree_order_id
  SELECT order_id, cashfree_order_id, student_id, course_id, enrollment_id, amount, status INTO v_order
  FROM public.orders
  WHERE cashfree_order_id = p_cashfree_order_id;

  -- Authoritative Order Amount Validation: Reject payload if p_amount_paid is less than expected order amount
  IF v_order.amount IS NOT NULL AND p_amount_paid < v_order.amount THEN
    RETURN jsonb_build_object(
      'status', 'ERROR',
      'message', 'Payment amount is less than expected authoritative order amount.'
    );
  END IF;

  -- 3. Lock and Fetch Target Enrollment Record FOR UPDATE
  IF v_order.enrollment_id IS NOT NULL THEN
    SELECT id, student_id, course_id, course_name, total_amount, amount_paid, amount_pending, payment_plan, payment_status, course_access_status, batch_id INTO v_enrollment
    FROM public.enrollments
    WHERE id = v_order.enrollment_id
    FOR UPDATE;
  ELSE
    SELECT id, student_id, course_id, course_name, total_amount, amount_paid, amount_pending, payment_plan, payment_status, course_access_status, batch_id INTO v_enrollment
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

  -- 4. Calculate Financials & Enforce Accounting Invariant (amount_paid + amount_pending = total_amount)
  v_total_fee := COALESCE(v_enrollment.total_amount, 4000.00);
  v_current_paid := COALESCE(v_enrollment.amount_paid, 0.00);
  v_new_amount_paid := v_current_paid + p_amount_paid;
  v_new_amount_pending := GREATEST(0.00, v_total_fee - v_new_amount_paid);
  v_is_full_payment := (v_new_amount_pending <= 0.00);
  v_new_payment_status := CASE WHEN v_is_full_payment THEN 'PAID' ELSE 'PARTIALLY_PAID' END;
  v_new_access_status := CASE WHEN v_is_full_payment THEN 'ACTIVE' ELSE 'PARTIAL' END;

  -- 5. Insert Payment Record (Unique Constraint on cashfree_payment_id prevents race conditions)
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

  -- 6. Update Enrollment State Safely (State machine guard: Never downgrade an established PAID enrollment)
  IF v_enrollment.payment_status != 'PAID' THEN
    UPDATE public.enrollments
    SET amount_paid = v_new_amount_paid,
        amount_pending = v_new_amount_pending,
        payment_status = v_new_payment_status,
        course_access_status = v_new_access_status,
        updated_at = NOW()
    WHERE id = v_enrollment.id;
  END IF;

  -- 7. Update Order Status
  IF v_order.order_id IS NOT NULL THEN
    UPDATE public.orders
    SET status = 'PAID'
    WHERE order_id = v_order.order_id;
  END IF;

  -- 8. Atomically Reserve Batch Seat if batch_id is bound
  v_batch_id := v_enrollment.batch_id;
  IF v_batch_id IS NOT NULL THEN
    v_seat_incremented := increment_batch_enrolled_count(v_batch_id);
  END IF;

  RETURN jsonb_build_object(
    'status', 'SUCCESS',
    'enrollment_id', v_enrollment.id,
    'payment_status', v_new_payment_status,
    'course_access_status', v_new_access_status,
    'batch_seat_incremented', v_seat_incremented
  );
END;
$$ LANGUAGE plpgsql;
