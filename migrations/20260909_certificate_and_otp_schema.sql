-- =========================================================================
-- INTERNNETRA LMS ARCHITECTURAL REMEDIATION SCHEMA (ARCH-03 & ARCH-12)
-- =========================================================================

-- 1. CERTIFICATE REQUESTS TABLE (ARCH-12 Persistent Storage)
CREATE TABLE IF NOT EXISTS public.certificate_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  certificate_id VARCHAR(255) NOT NULL UNIQUE,
  student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  enrollment_id UUID REFERENCES public.enrollments(id) ON DELETE SET NULL,
  student_name VARCHAR(255) NOT NULL,
  college_name VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING_APPROVAL', -- PENDING_APPROVAL | APPROVED | REJECTED
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  approved_by VARCHAR(255),
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cert_req_student_course ON public.certificate_requests(student_id, course_id);
CREATE INDEX IF NOT EXISTS idx_cert_req_status ON public.certificate_requests(status);
CREATE INDEX IF NOT EXISTS idx_cert_req_cert_id ON public.certificate_requests(certificate_id);


-- 2. OTP VERIFICATIONS TABLE (ARCH-03 Persistent Storage)
CREATE TABLE IF NOT EXISTS public.otp_verifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  otp_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 5,
  used BOOLEAN DEFAULT FALSE,
  full_name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_email ON public.otp_verifications(email);
CREATE INDEX IF NOT EXISTS idx_otp_expires_at ON public.otp_verifications(expires_at);
