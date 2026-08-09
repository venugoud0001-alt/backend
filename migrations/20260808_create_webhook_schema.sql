-- =========================================================================
-- INTERNNETRA CASHFREE WEBHOOK & ENROLLMENT DATABASE SCHEMA (SUPABASE)
-- =========================================================================

-- 1. COURSES TABLE
CREATE TABLE IF NOT EXISTS public.courses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title VARCHAR(255) NOT NULL UNIQUE,
  slug VARCHAR(255),
  price NUMERIC(10, 2) NOT NULL DEFAULT 4000.00,
  installment_price NUMERIC(10, 2) NOT NULL DEFAULT 1500.00,
  status VARCHAR(50) NOT NULL DEFAULT 'PUBLISHED',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS price NUMERIC(10, 2) DEFAULT 4000.00;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS installment_price NUMERIC(10, 2) DEFAULT 1500.00;

-- Seed Default Production Courses (Total: ₹4,000 | 1st Installment: ₹1,500 | 2nd Installment Balance: ₹2,500)
INSERT INTO public.courses (title, slug, price, installment_price, status)
VALUES 
  ('Full Stack Web Development', 'full-stack-development', 4000.00, 1500.00, 'PUBLISHED'),
  ('AI + Machine Learning', 'ai-machine-learning', 4000.00, 1500.00, 'PUBLISHED'),
  ('Data Science', 'data-science', 4000.00, 1500.00, 'PUBLISHED'),
  ('Cloud Computing', 'cloud-computing', 4000.00, 1500.00, 'PUBLISHED'),
  ('Cybersecurity', 'cybersecurity', 4000.00, 1500.00, 'PUBLISHED'),
  ('Python', 'python', 4000.00, 1500.00, 'PUBLISHED')
ON CONFLICT (title) DO UPDATE 
SET price = EXCLUDED.price, installment_price = EXCLUDED.installment_price;


-- 2. STUDENTS TABLE
CREATE TABLE IF NOT EXISTS public.students (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  account_status VARCHAR(50) NOT NULL DEFAULT 'NOT_ACTIVATED', -- NOT_ACTIVATED | ACTIVE | SUSPENDED
  email_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.students ADD COLUMN IF NOT EXISTS account_status VARCHAR(50) DEFAULT 'NOT_ACTIVATED';
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_students_email ON public.students(email);


-- 3. ENROLLMENTS TABLE
CREATE TABLE IF NOT EXISTS public.enrollments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  course_name VARCHAR(255) NOT NULL,
  total_amount NUMERIC(10, 2) NOT NULL DEFAULT 4000.00,
  amount_paid NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  amount_pending NUMERIC(10, 2) NOT NULL DEFAULT 4000.00,
  payment_plan VARCHAR(50) NOT NULL DEFAULT 'FULL', -- FULL | INSTALLMENT
  payment_status VARCHAR(50) NOT NULL DEFAULT 'PAYMENT_PENDING', -- PAYMENT_PENDING | PARTIALLY_PAID | PAID | FAILED
  course_access_status VARCHAR(50) NOT NULL DEFAULT 'LOCKED', -- LOCKED | PARTIAL | ACTIVE | COMPLETED
  account_status VARCHAR(50) NOT NULL DEFAULT 'NOT_ACTIVATED',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10, 2) DEFAULT 4000.00;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(10, 2) DEFAULT 0.00;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS amount_pending NUMERIC(10, 2) DEFAULT 4000.00;
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS payment_plan VARCHAR(50) DEFAULT 'FULL';
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'PAYMENT_PENDING';
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS course_access_status VARCHAR(50) DEFAULT 'LOCKED';
ALTER TABLE public.enrollments ADD COLUMN IF NOT EXISTS account_status VARCHAR(50) DEFAULT 'NOT_ACTIVATED';

CREATE INDEX IF NOT EXISTS idx_enrollments_student_id ON public.enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_course_id ON public.enrollments(course_id);


-- 4. ORDERS TABLE (Internal mapping from Cashfree Order ID to Student & Enrollment)
CREATE TABLE IF NOT EXISTS public.orders (
  order_id VARCHAR(255) PRIMARY KEY,
  cashfree_order_id VARCHAR(255) NOT NULL,
  student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  enrollment_id UUID REFERENCES public.enrollments(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL,
  installment_number INT NOT NULL DEFAULT 1,
  status VARCHAR(50) NOT NULL DEFAULT 'CREATED', -- CREATED | PAID | FAILED | CANCELLED
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_cashfree_order_id ON public.orders(cashfree_order_id);


-- 5. PAYMENTS TRANSACTION LOG TABLE (IDEMPOTENCY ENFORCED VIA cashfree_payment_id UNIQUE)
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  enrollment_id UUID REFERENCES public.enrollments(id) ON DELETE CASCADE,
  student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
  student_name VARCHAR(255),
  email VARCHAR(255),
  mobile VARCHAR(50),
  course_name VARCHAR(255),
  txn_id VARCHAR(255),
  cashfree_order_id VARCHAR(255),
  cashfree_payment_id VARCHAR(255),
  amount NUMERIC(10, 2),
  amount_paid NUMERIC(10, 2),
  total_course_fee NUMERIC(10, 2),
  remaining_balance NUMERIC(10, 2),
  payment_type VARCHAR(50) DEFAULT 'FULL', -- FULL | INSTALLMENT
  payment_method VARCHAR(100),
  status VARCHAR(50) DEFAULT 'SUCCESS', -- SUCCESS | FAILED | USER_DROPPED
  paid_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safely Add Missing Columns to Existing Payments Table
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS cashfree_order_id VARCHAR(255);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS cashfree_payment_id VARCHAR(255);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(10, 2);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS total_course_fee NUMERIC(10, 2);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(10, 2);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50) DEFAULT 'FULL';
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_payments_cashfree_payment_id ON public.payments(cashfree_payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_cashfree_order_id ON public.payments(cashfree_order_id);
CREATE INDEX IF NOT EXISTS idx_payments_email ON public.payments(email);
