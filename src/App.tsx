import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { AuthProvider } from './context/AuthContext'
import { isSupabaseConfigured } from './lib/supabaseClient'
import AppShell from './components/layout/AppShell'
import Login from './routes/Login'
import Dashboard from './routes/Dashboard'
import SitesList from './routes/sites/SitesList'
import SiteDetail from './routes/sites/SiteDetail'
import DrillingTaskForm from './routes/tasks/DrillingTaskForm'
import CoreDescriptionTaskForm from './routes/tasks/CoreDescriptionTaskForm'
import CoreSawingTaskForm from './routes/tasks/CoreSawingTaskForm'
import SamplingTaskForm from './routes/tasks/SamplingTaskForm'
import GeologyTaskWizard from './routes/tasks/GeologyTaskWizard'
import PlanWellForm from './routes/tasks/PlanWellForm'
import PlanWellsBulk from './routes/tasks/PlanWellsBulk'
import DailyReportForm from './routes/reports/DailyReportForm'
import TaskReportsList from './routes/reports/TaskReportsList'
import ReportDetail from './routes/reports/ReportDetail'
import PendingApprovals from './routes/reports/PendingApprovals'
import MyReports from './routes/reports/MyReports'
import DutySettings from './routes/duty/DutySettings'
import WellReportPrint from './routes/reports/WellReportPrint'
import ReportCorrections from './routes/reports/ReportCorrections'
import GeologyDayReport from './routes/reports/GeologyDayReport'
import ReportReview from './routes/reports/ReportReview'
import SummaryReport from './routes/reports/SummaryReport'
import TaskDashboard from './routes/tasks/TaskDashboard'
import UsersList from './routes/users/UsersList'
import CostCategoriesSettings from './routes/settings/CostCategoriesSettings'
import OrgChart from './routes/org/OrgChart'
import MyCrew from './routes/crew/MyCrew'
import DrillingOrganizationsSettings from './routes/settings/DrillingOrganizationsSettings'
import WorkersSettings from './routes/settings/WorkersSettings'
import SettingsHub from './routes/settings/SettingsHub'
// Карта подгружается отдельным куском (Leaflet ~150 КБ), только когда её открывают
const SiteMap = lazy(() => import('./routes/map/SiteMap'))
import SampleTypesSettings from './routes/settings/SampleTypesSettings'

// Каркас роутинга по экранам из ТЗ (раздел 5). Защита маршрутов по роли
// (AuthGuard/RequireRole) добавится позже; пока каждый экран сам проверяет
// profile.role и RLS всё равно не даст сделать лишнее на уровне БД.
function App() {
  return (
    <AuthProvider>
      {!isSupabaseConfigured && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'var(--color-danger)',
            color: '#fff',
            padding: '10px 20px',
            fontSize: 13,
            position: 'relative',
            zIndex: 50,
          }}
        >
          <AlertTriangle size={18} style={{ flexShrink: 0 }} />
          <span>
            <b>Supabase не настроен</b>: не заданы или некорректны
            VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY (подробности —
            в консоли браузера). Приложение работает без подключения к базе.
            Проверьте .env (локально) или секреты репозитория (GitHub Pages).
          </span>
        </div>
      )}
      <AppShell>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Dashboard />} />
          <Route path="/sites" element={<SitesList />} />
          <Route path="/sites/:siteId" element={<SiteDetail />} />
          <Route path="/settings" element={<SettingsHub />} />
          <Route
            path="/map"
            element={
              <Suspense fallback={<p>Загрузка карты…</p>}>
                <SiteMap />
              </Suspense>
            }
          />
          <Route path="/users" element={<UsersList />} />
          <Route path="/settings/costs" element={<CostCategoriesSettings />} />
          <Route path="/org-chart" element={<OrgChart />} />
          <Route path="/my-crew" element={<MyCrew />} />
          <Route path="/settings/organizations" element={<DrillingOrganizationsSettings />} />
          <Route path="/settings/workers" element={<WorkersSettings />} />
          <Route path="/settings/sample-types" element={<SampleTypesSettings />} />
          <Route path="/sites/:siteId/tasks/geology/new" element={<GeologyTaskWizard />} />
          <Route path="/sites/:siteId/tasks/drilling/plan" element={<PlanWellForm />} />
          <Route path="/sites/:siteId/tasks/drilling/plan-bulk" element={<PlanWellsBulk />} />
          <Route
            path="/sites/:siteId/tasks/drilling/new"
            element={<DrillingTaskForm />}
          />
          <Route
            path="/sites/:siteId/tasks/core-description/new"
            element={<CoreDescriptionTaskForm />}
          />
          <Route
            path="/sites/:siteId/tasks/core-sawing/new"
            element={<CoreSawingTaskForm />}
          />
          <Route
            path="/sites/:siteId/tasks/sampling/new"
            element={<SamplingTaskForm />}
          />
          <Route
            path="/sites/:siteId/tasks/drilling/:taskId/edit"
            element={<DrillingTaskForm />}
          />
          <Route
            path="/sites/:siteId/tasks/core-description/:taskId/edit"
            element={<CoreDescriptionTaskForm />}
          />
          <Route
            path="/sites/:siteId/tasks/core-sawing/:taskId/edit"
            element={<CoreSawingTaskForm />}
          />
          <Route
            path="/sites/:siteId/tasks/sampling/:taskId/edit"
            element={<SamplingTaskForm />}
          />
          <Route
            path="/tasks/:taskType/:taskId/dashboard"
            element={<TaskDashboard />}
          />
          <Route
            path="/tasks/:taskType/:taskId/reports"
            element={<TaskReportsList />}
          />
          <Route
            path="/tasks/:taskType/:taskId/reports/new"
            element={<DailyReportForm />}
          />
          <Route
            path="/tasks/:taskType/:taskId/reports/:reportId"
            element={<ReportDetail />}
          />
          <Route
            path="/tasks/:taskType/:taskId/reports/:reportId/edit"
            element={<DailyReportForm />}
          />
          <Route path="/reports/mine" element={<MyReports />} />
          <Route path="/duty" element={<DutySettings />} />
          <Route path="/reports/corrections" element={<ReportCorrections />} />
          <Route path="/reports/well/:taskId" element={<WellReportPrint />} />
          <Route path="/reports/geology" element={<GeologyDayReport />} />
          <Route path="/reports/pending" element={<PendingApprovals />} />
          <Route path="/reports/:reportId/review" element={<ReportReview />} />
          <Route path="/reports/summary" element={<SummaryReport />} />
        </Routes>
      </AppShell>
    </AuthProvider>
  )
}

export default App
