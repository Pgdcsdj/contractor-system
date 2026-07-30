import { createRouter, createWebHistory } from 'vue-router'
import { useAdminStore } from '@/stores/admin'

const routes = [
  {
    path: '/admin/login',
    name: 'AdminLogin',
    component: () => import('@/views/admin/LoginPage.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/admin',
    component: () => import('@/views/admin/LayoutPage.vue'),
    meta: { requiresAuth: true },
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
        path: 'trainings/:id/questions',
        name: 'TrainingQuestions',
        component: () => import('@/views/admin/TrainingQuestionsPage.vue'),
      },
      {
        path: 'records',
        name: 'Records',
        component: () => import('@/views/admin/RecordsPage.vue'),
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('@/views/admin/SettingsPage.vue'),
      },
      {
        path: 'categories',
        name: 'Categories',
        component: () => import('@/views/admin/CategoryPage.vue'),
      },
      {
        path: 'trainings/:id/import',
        name: 'QuizImport',
        component: () => import('@/views/admin/QuizImportPage.vue'),
      },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, from, next) => {
  const admin = useAdminStore()
  if (to.meta.requiresAuth !== false && !admin.isLoggedIn) {
    next({ name: 'AdminLogin' })
  } else {
    next()
  }
})

export default router
