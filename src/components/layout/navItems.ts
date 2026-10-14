import {
  LayoutDashboard,
  Mountain,
  ClipboardCheck,
  FileBarChart,
  FileClock,
  FilePen,
  FlaskConical,
  Map as MapIcon,
  Network,
  Settings,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { UserRole } from '../../types/roles'
import { isManagement } from '../../types/roles'
import type { WorkArea } from '../../types/database'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  show: (role: UserRole | null | undefined, can: (cap: string) => boolean, area?: WorkArea | null) => boolean
  badgeKey?: 'pendingApprovals'
  // Только для ПК: на телефоне (нижний таб-бар) пункт не показывается —
  // полевому работнику он не нужен (решение 30.09.2026).
  desktopOnly?: boolean
}

// Единый список пунктов навигации — источник и для верхнего меню (ПК), и
// для нижнего таб-бара (моб.), и для мобильной шапки, чтобы порядок и
// видимость по ролям не расходились между экранами.
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Дашборд', icon: LayoutDashboard, show: () => true },
  { to: '/sites', label: 'Участки', icon: Mountain, show: () => true },
  {
    to: '/reports/mine',
    label: 'Мои сводки',
    icon: FileClock,
    show: (role, _can, area) => role === 'party_chief' && area !== 'geology',
  },
  {
    to: '/my-crew',
    label: 'Моя бригада',
    icon: Users,
    show: (role, _can, area) => role === 'party_chief' && area === 'drilling',
  },
  { to: '/map', label: 'Карта', icon: MapIcon, show: () => true },
  {
    to: '/reports/geology',
    label: 'Геология',
    icon: FlaskConical,
    show: (role, _can, area) => role === 'party_chief' && area !== 'drilling',
  },
  {
    to: '/reports/pending',
    label: 'Согласование',
    icon: ClipboardCheck,
    show: (_role, can) => can('approve_reports'),
    badgeKey: 'pendingApprovals',
  },
  { to: '/reports/summary', label: 'Отчёты', icon: FileBarChart, show: (role, can) => isManagement(role) || can('view_all_data') },
  { to: '/reports/corrections', label: 'БД сводок', icon: FilePen, show: (_role, can) => can('corrections_db'), desktopOnly: true },
  // Пользователи/Работники/Организации бурения/Статьи затрат — раньше 4
  // отдельных пункта меню, из-за которых у management-роли набегало 9
  // пунктов (см. отзыв 25.09.2026 про overflow "Ещё" в BottomTabBar).
  // Свёрнуты в один хаб /settings (SettingsHub.tsx) — сами роуты
  // (/users, /settings/workers, /settings/organizations, /settings/costs)
  // НЕ переехали, только перестали быть пунктами верхнего уровня.
  { to: '/settings', label: 'Настройки', icon: Settings, show: isManagement },
  { to: '/org-chart', label: 'Оргструктура', icon: Network, show: () => true },
]

export function isNavItemActive(pathname: string, to: string) {
  if (to === '/') return pathname === '/'
  if (pathname === to || pathname.startsWith(`${to}/`)) return true
  // Задания и их сводки/дашборды (/tasks/...) логически часть "Участков" —
  // туда всегда попадают через карточку участка, отдельного пункта меню
  // для них нет (см. отзыв 17.09.2026: терялось ощущение "я всё ещё в
  // Участках", когда открыта карточка задания).
  if (to === '/sites' && pathname.startsWith('/tasks/')) return true
  // /users исторически без префикса /settings (роуты не переименовывали
  // при свёртке в хаб, см. запись 25.09.2026) — досчитываем вручную,
  // остальные 3 хабовых роута уже покрыты startsWith('/settings/') выше.
  if (to === '/settings' && pathname === '/users') return true
  return false
}
