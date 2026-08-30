-- =========================================================================
-- INTERNNETRA LMS: ROLE-BASED ACCESS CONTROL (RBAC) SCHEMA
-- =========================================================================

-- 1. ROLES TABLE
CREATE TABLE IF NOT EXISTS public.roles (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_system BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed Primary Roles
INSERT INTO public.roles (id, name, description, is_system)
VALUES 
  ('SUPER_ADMIN', 'Super Administrator', 'Complete platform administrative control and user delegation', TRUE),
  ('ADMIN', 'Delegated Administrator', 'Administrative account with granular explicit permissions', TRUE),
  ('STUDENT', 'Student / Learner', 'Standard student account for learning, courses, and certifications', TRUE)
ON CONFLICT (id) DO UPDATE 
SET name = EXCLUDED.name, description = EXCLUDED.description;

-- 2. PERMISSIONS TABLE
CREATE TABLE IF NOT EXISTS public.permissions (
  id VARCHAR(100) PRIMARY KEY, -- MODULE.ACTION format (e.g. course.create)
  module VARCHAR(50) NOT NULL,
  action VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed Granular Permissions Catalog
INSERT INTO public.permissions (id, module, action, description)
VALUES
  -- Dashboard
  ('dashboard.view', 'dashboard', 'view', 'View administrative dashboard and overview stats'),
  
  -- Department Management
  ('department.view', 'department', 'view', 'View academic departments'),
  ('department.create', 'department', 'create', 'Create new academic departments'),
  ('department.edit', 'department', 'edit', 'Update existing academic departments'),
  ('department.delete', 'department', 'delete', 'Delete or deactivate academic departments'),
  
  -- Course Management
  ('course.view', 'course', 'view', 'View courses in administrative catalog'),
  ('course.create', 'course', 'create', 'Create new programs and courses'),
  ('course.edit', 'course', 'edit', 'Update course details, metadata, and curriculum linkage'),
  ('course.publish', 'course', 'publish', 'Publish or unpublish courses to students'),
  ('course.archive', 'course', 'archive', 'Archive or delete courses'),
  
  -- Curriculum Builder
  ('curriculum.view', 'curriculum', 'view', 'View curriculum modules, lessons, and topics'),
  ('curriculum.create', 'curriculum', 'create', 'Create curriculum modules and lessons'),
  ('curriculum.edit', 'curriculum', 'edit', 'Edit curriculum modules, lessons, and topics'),
  ('curriculum.delete', 'curriculum', 'delete', 'Delete curriculum modules, lessons, or topics'),
  ('curriculum.reorder', 'curriculum', 'reorder', 'Reorder curriculum hierarchy and modules'),
  
  -- Video Management
  ('video.upload', 'video', 'upload', 'Upload video lectures directly to AWS S3'),
  ('video.retry', 'video', 'retry', 'Retry failed MediaConvert transcoding jobs'),
  ('video.delete', 'video', 'delete', 'Delete or replace lesson videos'),
  
  -- Pricing Management
  ('pricing.view', 'pricing', 'view', 'View course pricing plans'),
  ('pricing.create', 'pricing', 'create', 'Create pricing tiers and installment plans'),
  ('pricing.edit', 'pricing', 'edit', 'Update pricing amounts and discount rules'),
  ('pricing.activate', 'pricing', 'activate', 'Activate pricing plans'),
  ('pricing.deactivate', 'pricing', 'deactivate', 'Deactivate pricing plans'),
  
  -- Coupons & Offers
  ('coupon.view', 'coupon', 'view', 'View discount coupons and usage'),
  ('coupon.create', 'coupon', 'create', 'Create discount coupon codes'),
  ('coupon.edit', 'coupon', 'edit', 'Update coupon limits, dates, and discounts'),
  ('coupon.activate', 'coupon', 'activate', 'Activate coupon promotions'),
  ('coupon.deactivate', 'coupon', 'deactivate', 'Deactivate coupon promotions'),
  
  -- Student Management
  ('student.view', 'student', 'view', 'View student accounts and profiles'),
  ('student.manage', 'student', 'manage', 'Update student details and account records'),
  ('student.activate', 'student', 'activate', 'Activate student accounts'),
  ('student.deactivate', 'student', 'deactivate', 'Deactivate or lock student accounts'),
  
  -- Enrollment Management
  ('enrollment.view', 'enrollment', 'view', 'View course enrollments and cohort lists'),
  ('enrollment.manage', 'enrollment', 'manage', 'Manually enroll students or adjust enrollment status'),
  
  -- Payment Management
  ('payment.view', 'payment', 'view', 'View payment transactions, ledger, and balances'),
  ('payment.manage', 'payment', 'manage', 'Process offline payments and manual transaction reconciliation'),
  ('payment.export', 'payment', 'export', 'Export financial records and revenue ledgers'),
  
  -- Certificate Management
  ('certificate.view', 'certificate', 'view', 'View student certificate requests and issued credentials'),
  ('certificate.approve', 'certificate', 'approve', 'Approve verified certificate requests'),
  ('certificate.reject', 'certificate', 'reject', 'Reject or request revisions for certificate requests'),
  ('certificate.issue', 'certificate', 'issue', 'Generate and issue official verified certificates'),
  
  -- Analytics
  ('analytics.view', 'analytics', 'view', 'View platform analytics overview'),
  ('analytics.course', 'analytics', 'course', 'View course engagement analytics'),
  ('analytics.student', 'analytics', 'student', 'View student learning velocity and progress stats'),
  ('analytics.revenue', 'analytics', 'revenue', 'View financial revenue and cashflow analytics'),
  
  -- Admin Delegation (SUPER_ADMIN Only)
  ('admin.view', 'admin', 'view', 'View delegated administrative sub-users'),
  ('admin.create', 'admin', 'create', 'Create new delegated administrator accounts'),
  ('admin.edit', 'admin', 'edit', 'Update delegated administrator profiles'),
  ('admin.deactivate', 'admin', 'deactivate', 'Disable or lock administrative accounts'),
  ('admin.assign_permissions', 'admin', 'assign_permissions', 'Assign or revoke granular permissions'),
  
  -- System Settings
  ('settings.view', 'settings', 'view', 'View system settings and status diagnostics'),
  ('settings.manage', 'settings', 'manage', 'Manage system configuration and administrative policies')
ON CONFLICT (id) DO UPDATE 
SET module = EXCLUDED.module, action = EXCLUDED.action, description = EXCLUDED.description;

-- 3. SUB-USERS TABLE ENHANCEMENT (GRANULAR DELEGATION)
CREATE TABLE IF NOT EXISTS public.sub_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  designation VARCHAR(150),
  role VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
  permissions TEXT[] NOT NULL DEFAULT '{}',
  status VARCHAR(50) NOT NULL DEFAULT 'Active',
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_sub_user_role CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'STUDENT')),
  CONSTRAINT chk_sub_user_status CHECK (status IN ('Active', 'Disabled', 'Pending'))
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sub_users') THEN
    ALTER TABLE public.sub_users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'ADMIN';
    ALTER TABLE public.sub_users ADD COLUMN IF NOT EXISTS permissions TEXT[] DEFAULT '{}';
    ALTER TABLE public.sub_users ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);
    ALTER TABLE public.sub_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sub_users_email ON public.sub_users(email);
CREATE INDEX IF NOT EXISTS idx_sub_users_role ON public.sub_users(role);
CREATE INDEX IF NOT EXISTS idx_sub_users_status ON public.sub_users(status);

-- 4. AUDIT LOGS TABLE
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  actor_email VARCHAR(255) NOT NULL,
  actor_role VARCHAR(50) NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_resource VARCHAR(100),
  target_id VARCHAR(255),
  details JSONB DEFAULT '{}'::jsonb,
  ip_address VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_email);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at);

-- 5. ROW LEVEL SECURITY (RLS)
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sub_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_roles ON public.roles;
CREATE POLICY service_role_roles ON public.roles USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_permissions ON public.permissions;
CREATE POLICY service_role_permissions ON public.permissions USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_sub_users ON public.sub_users;
CREATE POLICY service_role_sub_users ON public.sub_users USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_audit_logs ON public.audit_logs;
CREATE POLICY service_role_audit_logs ON public.audit_logs USING (true) WITH CHECK (true);
