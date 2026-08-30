/**
 * Role-Based Access Control (RBAC) Constants & Granular Permissions
 * Naming convention: MODULE.ACTION
 */

const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  STUDENT: 'STUDENT'
};

const PERMISSIONS = {
  // Dashboard
  DASHBOARD_VIEW: 'dashboard.view',

  // Department Management
  DEPARTMENT_VIEW: 'department.view',
  DEPARTMENT_CREATE: 'department.create',
  DEPARTMENT_EDIT: 'department.edit',
  DEPARTMENT_DELETE: 'department.delete',

  // Course Management
  COURSE_VIEW: 'course.view',
  COURSE_CREATE: 'course.create',
  COURSE_EDIT: 'course.edit',
  COURSE_PUBLISH: 'course.publish',
  COURSE_ARCHIVE: 'course.archive',

  // Curriculum Builder
  CURRICULUM_VIEW: 'curriculum.view',
  CURRICULUM_CREATE: 'curriculum.create',
  CURRICULUM_EDIT: 'curriculum.edit',
  CURRICULUM_DELETE: 'curriculum.delete',
  CURRICULUM_REORDER: 'curriculum.reorder',

  // Video Management
  VIDEO_UPLOAD: 'video.upload',
  VIDEO_RETRY: 'video.retry',
  VIDEO_DELETE: 'video.delete',

  // Pricing Plans
  PRICING_VIEW: 'pricing.view',
  PRICING_CREATE: 'pricing.create',
  PRICING_EDIT: 'pricing.edit',
  PRICING_ACTIVATE: 'pricing.activate',
  PRICING_DEACTIVATE: 'pricing.deactivate',

  // Coupons & Offers
  COUPON_VIEW: 'coupon.view',
  COUPON_CREATE: 'coupon.create',
  COUPON_EDIT: 'coupon.edit',
  COUPON_ACTIVATE: 'coupon.activate',
  COUPON_DEACTIVATE: 'coupon.deactivate',

  // Student Accounts
  STUDENT_VIEW: 'student.view',
  STUDENT_MANAGE: 'student.manage',
  STUDENT_ACTIVATE: 'student.activate',
  STUDENT_DEACTIVATE: 'student.deactivate',

  // Enrollment Management
  ENROLLMENT_VIEW: 'enrollment.view',
  ENROLLMENT_MANAGE: 'enrollment.manage',

  // Payment Ledger
  PAYMENT_VIEW: 'payment.view',
  PAYMENT_MANAGE: 'payment.manage',
  PAYMENT_EXPORT: 'payment.export',

  // Certificate Management
  CERTIFICATE_VIEW: 'certificate.view',
  CERTIFICATE_APPROVE: 'certificate.approve',
  CERTIFICATE_REJECT: 'certificate.reject',
  CERTIFICATE_ISSUE: 'certificate.issue',

  // Analytics
  ANALYTICS_VIEW: 'analytics.view',
  ANALYTICS_COURSE: 'analytics.course',
  ANALYTICS_STUDENT: 'analytics.student',
  ANALYTICS_REVENUE: 'analytics.revenue',

  // Admin Delegation (SUPER_ADMIN Controlled)
  ADMIN_VIEW: 'admin.view',
  ADMIN_CREATE: 'admin.create',
  ADMIN_EDIT: 'admin.edit',
  ADMIN_DEACTIVATE: 'admin.deactivate',
  ADMIN_ASSIGN_PERMISSIONS: 'admin.assign_permissions',

  // System Settings
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_MANAGE: 'settings.manage'
};

// Convenient Permission Profiles for Fast Super-Admin Delegation
const PERMISSION_PROFILES = {
  CONTENT_ADMIN: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.DEPARTMENT_VIEW,
    PERMISSIONS.COURSE_VIEW,
    PERMISSIONS.COURSE_CREATE,
    PERMISSIONS.COURSE_EDIT,
    PERMISSIONS.COURSE_PUBLISH,
    PERMISSIONS.CURRICULUM_VIEW,
    PERMISSIONS.CURRICULUM_CREATE,
    PERMISSIONS.CURRICULUM_EDIT,
    PERMISSIONS.CURRICULUM_REORDER,
    PERMISSIONS.VIDEO_UPLOAD,
    PERMISSIONS.VIDEO_RETRY,
    PERMISSIONS.ANALYTICS_COURSE
  ],
  FINANCE_ADMIN: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.COURSE_VIEW,
    PERMISSIONS.PRICING_VIEW,
    PERMISSIONS.PRICING_CREATE,
    PERMISSIONS.PRICING_EDIT,
    PERMISSIONS.PRICING_ACTIVATE,
    PERMISSIONS.PRICING_DEACTIVATE,
    PERMISSIONS.COUPON_VIEW,
    PERMISSIONS.COUPON_CREATE,
    PERMISSIONS.COUPON_EDIT,
    PERMISSIONS.COUPON_ACTIVATE,
    PERMISSIONS.COUPON_DEACTIVATE,
    PERMISSIONS.PAYMENT_VIEW,
    PERMISSIONS.PAYMENT_MANAGE,
    PERMISSIONS.PAYMENT_EXPORT,
    PERMISSIONS.ANALYTICS_REVENUE
  ],
  STUDENT_SUPPORT_ADMIN: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.COURSE_VIEW,
    PERMISSIONS.STUDENT_VIEW,
    PERMISSIONS.STUDENT_MANAGE,
    PERMISSIONS.ENROLLMENT_VIEW,
    PERMISSIONS.ENROLLMENT_MANAGE,
    PERMISSIONS.CERTIFICATE_VIEW,
    PERMISSIONS.CERTIFICATE_APPROVE,
    PERMISSIONS.CERTIFICATE_REJECT,
    PERMISSIONS.ANALYTICS_STUDENT
  ],
  FULL_ADMIN: Object.values(PERMISSIONS).filter(
    p => p !== PERMISSIONS.ADMIN_ASSIGN_PERMISSIONS && p !== PERMISSIONS.SETTINGS_MANAGE
  )
};

// Grouped Permissions Catalog for UI Matrix Rendering
const PERMISSION_GROUPS = [
  {
    module: 'Dashboard',
    permissions: [
      { code: PERMISSIONS.DASHBOARD_VIEW, label: 'View Dashboard & Analytics' }
    ]
  },
  {
    module: 'Department Management',
    permissions: [
      { code: PERMISSIONS.DEPARTMENT_VIEW, label: 'View Departments' },
      { code: PERMISSIONS.DEPARTMENT_CREATE, label: 'Create Departments' },
      { code: PERMISSIONS.DEPARTMENT_EDIT, label: 'Edit Departments' },
      { code: PERMISSIONS.DEPARTMENT_DELETE, label: 'Delete Departments' }
    ]
  },
  {
    module: 'Course & Curriculum Management',
    permissions: [
      { code: PERMISSIONS.COURSE_VIEW, label: 'View Courses' },
      { code: PERMISSIONS.COURSE_CREATE, label: 'Create Courses' },
      { code: PERMISSIONS.COURSE_EDIT, label: 'Edit Courses' },
      { code: PERMISSIONS.COURSE_PUBLISH, label: 'Publish Courses' },
      { code: PERMISSIONS.COURSE_ARCHIVE, label: 'Archive / Delete Courses' },
      { code: PERMISSIONS.CURRICULUM_VIEW, label: 'View Curriculum Structure' },
      { code: PERMISSIONS.CURRICULUM_CREATE, label: 'Create Modules & Lessons' },
      { code: PERMISSIONS.CURRICULUM_EDIT, label: 'Edit Modules & Lessons' },
      { code: PERMISSIONS.CURRICULUM_DELETE, label: 'Delete Modules & Lessons' },
      { code: PERMISSIONS.CURRICULUM_REORDER, label: 'Reorder Curriculum Hierarchy' },
      { code: PERMISSIONS.VIDEO_UPLOAD, label: 'Upload Videos to S3' },
      { code: PERMISSIONS.VIDEO_RETRY, label: 'Retry Transcoding Jobs' }
    ]
  },
  {
    module: 'Pricing & Coupons',
    permissions: [
      { code: PERMISSIONS.PRICING_VIEW, label: 'View Pricing' },
      { code: PERMISSIONS.PRICING_CREATE, label: 'Create Pricing Plans' },
      { code: PERMISSIONS.PRICING_EDIT, label: 'Edit Pricing Plans' },
      { code: PERMISSIONS.COUPON_VIEW, label: 'View Coupons' },
      { code: PERMISSIONS.COUPON_CREATE, label: 'Create Coupons' },
      { code: PERMISSIONS.COUPON_EDIT, label: 'Edit Coupons' },
      { code: PERMISSIONS.COUPON_ACTIVATE, label: 'Activate/Deactivate Coupons' }
    ]
  },
  {
    module: 'Student & Enrollment Operations',
    permissions: [
      { code: PERMISSIONS.STUDENT_VIEW, label: 'View Student Accounts' },
      { code: PERMISSIONS.STUDENT_MANAGE, label: 'Manage Student Profiles' },
      { code: PERMISSIONS.STUDENT_DEACTIVATE, label: 'Deactivate Students' },
      { code: PERMISSIONS.ENROLLMENT_VIEW, label: 'View Enrollments' },
      { code: PERMISSIONS.ENROLLMENT_MANAGE, label: 'Manage Enrollments' }
    ]
  },
  {
    module: 'Payments & Financial Ledger',
    permissions: [
      { code: PERMISSIONS.PAYMENT_VIEW, label: 'View Payment Ledger' },
      { code: PERMISSIONS.PAYMENT_MANAGE, label: 'Manage & Reconcile Transactions' },
      { code: PERMISSIONS.PAYMENT_EXPORT, label: 'Export Financial Reports' }
    ]
  },
  {
    module: 'Certificate Management',
    permissions: [
      { code: PERMISSIONS.CERTIFICATE_VIEW, label: 'View Certificate Requests' },
      { code: PERMISSIONS.CERTIFICATE_APPROVE, label: 'Approve Certificates' },
      { code: PERMISSIONS.CERTIFICATE_REJECT, label: 'Reject Certificates' },
      { code: PERMISSIONS.CERTIFICATE_ISSUE, label: 'Issue Verified Certificates' }
    ]
  },
  {
    module: 'Analytics & Reporting',
    permissions: [
      { code: PERMISSIONS.ANALYTICS_VIEW, label: 'View Analytics Overview' },
      { code: PERMISSIONS.ANALYTICS_COURSE, label: 'Course Analytics' },
      { code: PERMISSIONS.ANALYTICS_STUDENT, label: 'Student Analytics' },
      { code: PERMISSIONS.ANALYTICS_REVENUE, label: 'Revenue Analytics' }
    ]
  },
  {
    module: 'Administrative Delegation',
    permissions: [
      { code: PERMISSIONS.ADMIN_VIEW, label: 'View Delegated Admins' },
      { code: PERMISSIONS.ADMIN_CREATE, label: 'Create Delegated Admins' },
      { code: PERMISSIONS.ADMIN_EDIT, label: 'Edit Delegated Admins' },
      { code: PERMISSIONS.ADMIN_DEACTIVATE, label: 'Deactivate Admins' },
      { code: PERMISSIONS.ADMIN_ASSIGN_PERMISSIONS, label: 'Assign Granular Permissions' }
    ]
  }
];

module.exports = {
  ROLES,
  PERMISSIONS,
  PERMISSION_PROFILES,
  PERMISSION_GROUPS
};
