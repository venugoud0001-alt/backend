-- =========================================================================
-- INTERNNETRA PERMANENT PUBLIC ENROLLMENT & BATCH SYSTEM SCHEMA (SUPABASE)
-- =========================================================================

-- 1. COURSES TABLE COLUMNS
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS price NUMERIC(12, 2) DEFAULT 4000.00;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS installment_price NUMERIC(12, 2) DEFAULT 1500.00;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS curriculum_pdf_url TEXT;

-- 2. BATCHES TABLE
CREATE TABLE IF NOT EXISTS public.batches (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  batch_name VARCHAR(255) NOT NULL,
  batch_code VARCHAR(100) NOT NULL UNIQUE,
  start_date DATE NOT NULL,
  end_date DATE,
  schedule VARCHAR(255) NOT NULL DEFAULT 'Monday - Friday (6:00 PM - 8:30 PM)',
  mode VARCHAR(50) NOT NULL DEFAULT 'Online', -- Online | Hybrid
  capacity INT NOT NULL DEFAULT 50,
  enrolled_count INT NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | FULL | CLOSED
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_batches_course_id ON public.batches(course_id);

-- 3. STUDENTS TABLE COLUMNS
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS account_status VARCHAR(50) DEFAULT 'NOT_ACTIVATED';
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;

-- 4. ENROLLMENTS TABLE COLUMNS (HISTORICAL SNAPSHOTS & SEAT RESERVATION)
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES public.batches(id) ON DELETE SET NULL;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS batch_name VARCHAR(255);
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS total_amount NUMERIC(12, 2) DEFAULT 4000.00;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS installment_amount NUMERIC(12, 2) DEFAULT 1500.00;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12, 2) DEFAULT 0.00;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS amount_pending NUMERIC(12, 2) DEFAULT 4000.00;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS payment_plan VARCHAR(50) DEFAULT 'FULL';
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'PAYMENT_PENDING';
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS course_access_status VARCHAR(50) DEFAULT 'LOCKED';
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS account_status VARCHAR(50) DEFAULT 'NOT_ACTIVATED';
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS installment_due_at TIMESTAMPTZ;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS seat_reserved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_enrollments_batch_id ON public.enrollments(batch_id);

-- 5. ORDERS TABLE COLUMNS
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES public.batches(id) ON DELETE SET NULL;

-- 6. PAYMENTS TRANSACTION LOG TABLE
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS cashfree_order_id VARCHAR(255);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS cashfree_payment_id VARCHAR(255);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12, 2);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS total_course_fee NUMERIC(12, 2);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(12, 2);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50) DEFAULT 'FULL';

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_cashfree_payment_id_unique ON public.payments(cashfree_payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_cashfree_order_id ON public.payments(cashfree_order_id);

-- 7. ATOMIC STORED FUNCTION: increment_batch_enrolled_count(p_batch_id UUID) RETURNS BOOLEAN
-- Prevents race conditions during concurrent seat reservations and auto-updates batch status to FULL
CREATE OR REPLACE FUNCTION increment_batch_enrolled_count(p_batch_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_capacity INT;
  v_enrolled INT;
  v_status VARCHAR(50);
BEGIN
  IF p_batch_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Lock target batch row for update to prevent concurrent race conditions
  SELECT capacity, enrolled_count, status INTO v_capacity, v_enrolled, v_status
  FROM public.batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND OR v_status = 'CLOSED' OR v_status = 'FULL' THEN
    RETURN FALSE;
  END IF;

  IF v_enrolled >= v_capacity THEN
    UPDATE public.batches SET status = 'FULL', updated_at = NOW() WHERE id = p_batch_id;
    RETURN FALSE;
  END IF;

  -- Increment enrolled_count atomically
  UPDATE public.batches
  SET enrolled_count = enrolled_count + 1,
      status = CASE WHEN enrolled_count + 1 >= v_capacity THEN 'FULL' ELSE status END,
      updated_at = NOW()
  WHERE id = p_batch_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
