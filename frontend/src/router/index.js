import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useAdminStore } from '@/stores/admin'

const routes = [
  {
    path: '/',
    redirect: '/login',
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginPage.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/quiz',
    name: 'QuizList',
    component: () => import('@/views/QuizListPage.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/quiz/:id',
    name: 'Quiz',
    component: () => import('@/views/QuizPage.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/result/:trainingId',
    name: 'Result',
    component: () => import('@/views/ResultPage.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/offline-records',
    name: 'OfflineRecords',
    component: () => import('@/views/OfflineRecordsPage.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/wrong-questions',
    name: 'WrongQuestions',
    component: () => import('@/views/WrongQuestionsPage.vue'),
    meta: { requiresAuth: true },
  },
  // ── 安全员工作台路由（模块 A）──────────────────────────────────────────
  {
    path: '/safety/login',
    name: 'SafetyLogin',
    component: () => import('@/views/safety/SafetyLoginPage.vue'),
    meta: { requiresAuth: false, isSafety: true },
  },
  {
    path: '/safety',
    component: () => import('@/views/safety/SafetyLayout.vue'),
    meta: { requiresAuth: true, role: 'safety' },
    children: [
      { path: '', redirect: '/safety/workbench' },
      {
        path: 'workbench',
        name: 'SafetyWorkbench',
        component: () => import('@/views/safety/SafetyWorkbench.vue'),
      },
      {
        path: 'report',
        name: 'SafetyReport',
        component: () => import('@/views/safety/SafetyReportForm.vue'),
      },
      {
        path: 'rectify',
        name: 'SafetyRectify',
        component: () => import('@/views/safety/SafetyRectifyList.vue'),
      },
    ],
  },
  // ── 承包商开工资料上报（需求 C，公开免登录）──────────────────────────────
  {
    path: '/contractor-docs',
    name: 'ContractorDocSubmit',
    component: () => import('@/views/contractor/ContractorDocSubmit.vue'),
    meta: { requiresAuth: false },
  },
  // ── 管理后台路由 ──
  {
    path: '/admin/login',
    name: 'AdminLogin',
    component: () => import('@/views/admin/LoginPage.vue'),
    meta: { requiresAuth: false, isAdmin: true },
  },
  {
    path: '/admin',
    component: () => import('@/views/admin/LayoutPage.vue'),
    meta: { requiresAuth: false, isAdmin: true }, // 不在全局守卫拦截
    children: [
      {
        path: '',
        redirect: '/admin/dashboard',
      },
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/admin/DashboardPage.vue'),
      },
      {
        path: 'users',
        name: 'Users',
        component: () => import('@/views/admin/UsersPage.vue'),
      },
      {
        path: 'trainings',
        name: 'Trainings',
        component: () => import('@/views/admin/TrainingsPage.vue'),
      },
      {
        path: 'trainings/new',
        name: 'NewTraining',
        component: () => import('@/views/admin/TrainingFormPage.vue'),
      },
      {
        path: 'records',
        name: 'Records',
        component: () => import('@/views/admin/RecordsPage.vue'),
      },
      {
        path: 'records/:id',
        name: 'RecordGrade',
        component: () => import('@/views/admin/EssayGradePage.vue'),
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('@/views/admin/SettingsPage.vue'),
      },
      {
        path: 'categories',
        name: 'Categories',
        component: () => import('@/views/admin/CategoriesPage.vue'),
      },
      {
        path: 'contractor-units',
        name: 'ContractorUnits',
        component: () => import('@/views/admin/ContractorUnitsPage.vue'),
      },
      {
        path: 'hazard-report',
        name: 'HazardReport',
        component: () => import('@/views/admin/HazardReportPage.vue'),
      },
      {
        path: 'hazard-loop',
        name: 'HazardLoop',
        component: () => import('@/views/admin/HazardLoopPage.vue'),
      },
      {
        path: 'hazard-monitor',
        name: 'HazardMonitor',
        component: () => import('@/views/admin/HazardMonitorPage.vue'),
      },
      {
        path: 'hazard-settings',
        name: 'HazardSettings',
        component: () => import('@/views/admin/HazardSettingsPage.vue'),
      },
      {
        path: 'accounts',
        name: 'AccountManage',
        component: () => import('@/views/admin/AccountManagePage.vue'),
      },
      {
        path: 'data',
        name: 'DataManage',
        component: () => import('@/views/admin/DataManagePage.vue'),
      },
      {
        path: 'trainings/:id/questions',
        name: 'TrainingQuestions',
        component: () => import('@/views/admin/TrainingQuestionsPage.vue'),
      },
      {
        path: 'trainings/:id/import',
        name: 'QuizImport',
        component: () => import('@/views/admin/QuizImportPage.vue'),
      },
      {
        path: 'contractor-docs',
        name: 'ContractorDocs',
        component: () => import('@/views/admin/ContractorDocManage.vue'),
      },
      {
        path: 'quality/:id',
        name: 'QualityCheck',
        component: () => import('@/views/admin/QualityCheckPage.vue'),
      },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

// 路由守卫：检查登录状态（区分管理后台 / 安全员 / 移动端）
router.beforeEach((to, from, next) => {
  // 管理后台路由 → 用 admin store 鉴权
  if (to.path.startsWith('/admin')) {
    // 登录页本身不需要鉴权
    if (to.name === 'AdminLogin') {
      next()
      return
    }
    const admin = useAdminStore()
    if (!admin.isLoggedIn) {
      next({ name: 'AdminLogin' })
      return
    }
    // 安全员禁止进入管理后台 → 重定向到工作台（设计 §8.9 双保险）
    if (admin.user && admin.user.role === 'safety') {
      next('/safety/workbench')
      return
    }
    next()
    return
  }

  // 安全员路由 → 用 admin store 鉴权（token 复用 tnb_admin_token，user.role='safety'）
  if (to.path.startsWith('/safety')) {
    // 登录页：已登录的安全员直接进工作台
    if (to.name === 'SafetyLogin') {
      const admin = useAdminStore()
      if (admin.isLoggedIn && admin.user && admin.user.role === 'safety') {
        next('/safety/workbench')
        return
      }
      next()
      return
    }
    const admin = useAdminStore()
    // 必须已登录且角色为 safety
    if (!admin.isLoggedIn || !admin.user || admin.user.role !== 'safety') {
      next('/safety/login')
      return
    }
    next()
    return
  }

  // 移动端路由 → 用 auth store 鉴权
  const auth = useAuthStore()
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    next({ name: 'Login', query: { redirect: to.fullPath } })
    return
  }
  next()
})

export default router
