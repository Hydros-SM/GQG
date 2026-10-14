import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ChevronLeft, Layers, Plus, ChevronRight, Lock, Unlock, Scissors, FlaskConical, Pencil, FileText, History, CalendarClock, Play, Table2 } from 'lucide-react'
import Modal from '../../components/Modal'
import SiteOverview from '../../components/SiteOverview'
import StartDrillingModal from '../../components/StartDrillingModal'
import MasterStartDrilling from '../../components/MasterStartDrilling'
import { useIsMobile } from '../../hooks/useMediaQuery'
import type { DrillingTask as DrillingTaskRow } from '../../types/database'
import type { LucideIcon } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../context/AuthContext'
import { isManagement } from '../../types/roles'
import { riseIn } from '../../lib/motionVariants'
import { drillingProgress, coreProgress, sawingProgress, samplingProgress, fetchForeignDrillingProgress } from '../../lib/taskProgress'
import { TaskStatusBadge } from '../../components/StatusBadge'
import ProgressBar from '../../components/ProgressBar'
import DerrickIcon from '../../components/icons/DerrickIcon'
import type {
  CoreDescriptionTask,
  CoreSawingTask,
  DrillingTask,
  Report,
  SamplingTask,
  Site,
} from '../../types/database'
import { shortName } from '../../lib/shortName'

// Формулы прогресса — общие с Dashboard.tsx, см. src/lib/taskProgress.ts
// (вынесены туда 25.09.2026, фаза 3 редизайна: сводный прогресс участка
// на дашборде считается теми же функциями, не копией).

// Сколько сводок задания сейчас "требуют внимания" — на согласовании или
// отклонены. Бригадиру и техдиру так видно, не заходя в каждое задание,
// всё ли заполнено (см. отзыв 17.09.2026).
type TaskFkField = 'drilling_task_id' | 'core_description_task_id' | 'core_sawing_task_id' | 'sampling_task_id'
function attentionCounts(taskId: string, taskField: TaskFkField, reports: Report[]) {
  const rows = reports.filter((r) => r[taskField] === taskId)
  return {
    submitted: rows.filter((r) => r.approval_status === 'submitted').length,
    rejected: rows.filter((r) => r.approval_status === 'rejected').length,
  }
}

// Керн/распиловка/опробование, прицепленные к конкретной скважине —
// рендерятся вложенными строками внутри её карточки (см. отзыв 19.09.2026),
// а не отдельными карточками верхнего уровня. Разные виды несут разные
// метрики, отсюда объединение через union по наличию поля.
interface AttachedRowBase {
  key: string
  taskType: 'core-description' | 'core-sawing' | 'sampling'
  taskId: string
  icon: LucideIcon
  label: string
  attention: { submitted: number; rejected: number }
}
type AttachedRow =
  | (AttachedRowBase & { progress: { core: number; photo: number }; plan: number | null })
  | (AttachedRowBase & { sawn: number; plan: number | null })
  | (AttachedRowBase & { samples: { taken: number; submitted: number } })

function AttentionBadges({ submitted, rejected }: { submitted: number; rejected: number }) {
  if (submitted === 0 && rejected === 0) return null
  return (
    <span style={{ display: 'inline-flex', gap: 5 }}>
      {submitted > 0 && (
        <span className="badge badge-primary num" title="Сводок на согласовании">
          {submitted} на согл.
        </span>
      )}
      {rejected > 0 && (
        <span className="badge badge-danger num" title="Отклонённых сводок">
          {rejected} откл.
        </span>
      )}
    </span>
  )
}

export default function SiteDetail() {
  const { siteId } = useParams<{ siteId: string }>()
  const { session, profile, canCreateWells, loading: authLoading } = useAuth()

  const [site, setSite] = useState<Site | null>(null)
  const [drillingTasks, setDrillingTasks] = useState<DrillingTask[]>([])
  const [coreTasks, setCoreTasks] = useState<CoreDescriptionTask[]>([])
  const [sawingTasks, setSawingTasks] = useState<CoreSawingTask[]>([])
  const [samplingTasks, setSamplingTasks] = useState<SamplingTask[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [togglingStatus, setTogglingStatus] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  // Фильтр скважин по состоянию (в адресе ?filter=…) и запуск бурения запланированной
  const [searchParams, setSearchParams] = useSearchParams()
  const statusFilter = (searchParams.get('filter') ?? 'all') as 'all' | 'planned' | 'in_progress' | 'suspended' | 'completed'
  const [startingWell, setStartingWell] = useState<DrillingTaskRow | null>(null)
  const isMobile = useIsMobile()
  const [authorNames, setAuthorNames] = useState<Record<string, string>>({})
  // Прогресс бурения чужих скважин (геолог) — через RPC, см. taskProgress.ts
  const [foreignProgress, setForeignProgress] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!profile || !isManagement(profile.role)) return
    const ids = [...new Set(drillingTasks.map((t) => t.created_by))]
    if (ids.length === 0) return
    supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', ids)
      .then(({ data }) =>
        setAuthorNames(Object.fromEntries(((data ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, shortName(p.full_name)]))),
      )
  }, [drillingTasks, profile])

  useEffect(() => {
    if (!profile || isManagement(profile.role)) return
    const foreignIds = drillingTasks.filter((t) => t.foreman_id !== profile.id).map((t) => t.id)
    if (foreignIds.length === 0) return
    let cancelled = false
    fetchForeignDrillingProgress(foreignIds).then((res) => {
      if (!cancelled) setForeignProgress(res)
    })
    return () => {
      cancelled = true
    }
  }, [drillingTasks, profile])

  // Переименование участка (25.09.2026, по запросу заказчика) — раньше
  // название задавалось только при создании и больше нигде не
  // редактировалось. Тот же паттерн, что и переименование статей затрат/
  // организаций бурения: карандаш → модалка → .update().
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  useEffect(() => {
    if (!session || !siteId) return

    async function load() {
      setLoading(true)
      const [siteRes, drillingRes, coreRes, sawingRes, samplingRes] = await Promise.all([
        supabase.from('sites').select('*').eq('id', siteId).single(),
        supabase
          .from('drilling_tasks')
          .select('*')
          .eq('site_id', siteId)
          .order('created_at', { ascending: false }),
        supabase
          .from('core_description_tasks')
          .select('*')
          .eq('site_id', siteId)
          .order('created_at', { ascending: false }),
        supabase
          .from('core_sawing_tasks')
          .select('*')
          .eq('site_id', siteId)
          .order('created_at', { ascending: false }),
        supabase
          .from('sampling_tasks')
          .select('*')
          .eq('site_id', siteId)
          .order('created_at', { ascending: false }),
      ])

      if (siteRes.error) setError(siteRes.error.message)
      else setSite(siteRes.data)

      if (drillingRes.error) setError(drillingRes.error.message)
      else setDrillingTasks(drillingRes.data ?? [])

      if (coreRes.error) setError(coreRes.error.message)
      else setCoreTasks(coreRes.data ?? [])

      if (sawingRes.error) setError(sawingRes.error.message)
      else setSawingTasks(sawingRes.data ?? [])

      if (samplingRes.error) setError(samplingRes.error.message)
      else setSamplingTasks(samplingRes.data ?? [])

      const { data: reportRows } = await supabase
        .from('reports')
        .select('*')
        .eq('site_id', siteId)
      setReports(reportRows ?? [])

      setLoading(false)
    }

    load()
  }, [session, siteId])

  async function toggleSiteStatus() {
    if (!site) return
    setTogglingStatus(true)
    const nextStatus = site.status === 'active' ? 'closed' : 'active'
    const { error: updateError } = await supabase
      .from('sites')
      .update({ status: nextStatus })
      .eq('id', site.id)
    setTogglingStatus(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    setSite({ ...site, status: nextStatus })
  }

  function openEdit() {
    if (!site) return
    setEditName(site.name)
    setEditError(null)
    setEditOpen(true)
  }

  async function handleEditSave(e: FormEvent) {
    e.preventDefault()
    if (!site) return
    setEditSaving(true)
    setEditError(null)
    const { data, error: updateError } = await supabase
      .from('sites')
      .update({ name: editName.trim() })
      .eq('id', site.id)
      .select()
      .single()
    setEditSaving(false)
    if (updateError) {
      setEditError(updateError.message)
      return
    }
    setSite(data)
    setEditOpen(false)
  }

  if (authLoading) return <p>Загрузка…</p>
  if (!session) return <Navigate to="/login" replace />
  if (!siteId) return <p>Не указан участок.</p>

  const siteAttention = {
    submitted: reports.filter((r) => r.approval_status === 'submitted').length,
    rejected: reports.filter((r) => r.approval_status === 'rejected').length,
  }

  // Задания на скважину подрядчика (без drilling_task_id) не к чему
  // прицепить — остаются отдельными списками, как раньше. "Свои" уходят
  // вложенными в карточку соответствующей скважины бурения (см. выше).
  const externalCoreTasks = coreTasks.filter((t) => !t.drilling_task_id)
  const externalSamplingTasks = samplingTasks.filter((t) => !t.drilling_task_id)

  return (
    <div>
      <Link
        to="/sites"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 14 }}
      >
        <ChevronLeft size={15} /> Все участки
      </Link>

      {error && <p className="text-error">{error}</p>}

      {loading ? (
        <div className="skeleton" style={{ height: 140, borderRadius: 'var(--radius-md)' }} />
      ) : !site ? (
        <p>Участок не найден или недоступен.</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>{site.name}</h1>
            {isManagement(profile?.role) && (
              <button
                type="button"
                onClick={openEdit}
                title="Переименовать участок"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 28,
                  height: 28,
                  borderRadius: 'var(--radius-full)',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--color-text-muted)',
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                <Pencil size={14} />
              </button>
            )}
            <span className={`badge badge-${site.status === 'active' ? 'primary' : 'neutral'}`}>
              {site.status === 'active' ? 'активен' : 'закрыт'}
            </span>
            {isManagement(profile?.role) && (
              <button
                type="button"
                className="btn-outline"
                onClick={toggleSiteStatus}
                disabled={togglingStatus}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '4px 10px' }}
              >
                {site.status === 'active' ? <Lock size={13} /> : <Unlock size={13} />}
                {site.status === 'active' ? 'Закрыть участок' : 'Открыть участок'}
              </button>
            )}
          </div>
          <AttentionBadges submitted={siteAttention.submitted} rejected={siteAttention.rejected} />

          <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Переименовать участок">
            <form onSubmit={handleEditSave} style={{ display: 'grid', gap: 12 }}>
              <label>
                Название участка
                <input
                  autoFocus
                  required
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </label>
              {editError && <p className="text-error" style={{ margin: 0 }}>{editError}</p>}
              <button type="submit" disabled={editSaving}>
                {editSaving ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </form>
          </Modal>

          {isManagement(profile?.role) && (
            <div style={{ margin: '16px 0 24px' }}>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Plus size={16} /> Задание
              </button>
            </div>
          )}

          {canCreateWells && !isManagement(profile?.role) && (
            <div style={{ margin: '16px 0 24px' }}>
              <Link to={`/sites/${siteId}/tasks/drilling/new`}>
                <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Plus size={16} /> Новая скважина
                </button>
              </Link>
            </div>
          )}

          <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Новое задание">
            <div style={{ display: 'grid', gap: 10 }}>
              <p className="text-muted" style={{ margin: 0 }}>Что нужно сделать на участке?</p>
              <Link to={`/sites/${siteId}/tasks/drilling/new`} className="card card-interactive" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, color: 'var(--color-text)' }}>
                <DerrickIcon size={22} />
                <span style={{ display: 'grid' }}>
                  <b>Бурение</b>
                  <span className="text-muted" style={{ fontSize: 13 }}>Новая скважина, затем можно сразу назначить геологию</span>
                </span>
              </Link>
              <Link to={`/sites/${siteId}/tasks/drilling/plan`} className="card card-interactive" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, color: 'var(--color-text)' }}>
                <CalendarClock size={22} />
                <span style={{ display: 'grid' }}>
                  <b>Запланировать скважину</b>
                  <span className="text-muted" style={{ fontSize: 13 }}>Номер, координаты, глубина, угол — без станка, бригадира и даты</span>
                </span>
              </Link>
              <Link to={`/sites/${siteId}/tasks/drilling/plan-bulk`} className="card card-interactive" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, color: 'var(--color-text)' }}>
                <Table2 size={22} />
                <span style={{ display: 'grid' }}>
                  <b>Запланировать списком</b>
                  <span className="text-muted" style={{ fontSize: 13 }}>Много скважин сразу: вставка из Excel или CSV</span>
                </span>
              </Link>
              <Link to={`/sites/${siteId}/tasks/geology/new`} className="card card-interactive" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, color: 'var(--color-text)' }}>
                <Layers size={22} />
                <span style={{ display: 'grid' }}>
                  <b>Геология</b>
                  <span className="text-muted" style={{ fontSize: 13 }}>Документация керна, распиловка, опробование на существующей скважине</span>
                </span>
              </Link>
            </div>
          </Modal>

          {profile?.role === 'party_chief' && (
            <MasterStartDrilling
              plannedWells={drillingTasks.filter((t) => t.status === 'planned') as unknown as DrillingTask[]}
              onStarted={(updated) => setDrillingTasks((prev) => prev.map((t) => (t.id === updated.id ? ({ ...t, ...updated } as typeof t) : t)))}
            />
          )}

          {startingWell && (
            <StartDrillingModal
              well={startingWell}
              open
              onClose={() => setStartingWell(null)}
              onStarted={(updated) => {
                setDrillingTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
                setStartingWell(null)
              }}
            />
          )}

          {isManagement(profile?.role) && <SiteOverview drillingTasks={drillingTasks} reports={reports} />}

          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <DerrickIcon size={18} className="text-muted" /> Бурение скважин
          </h2>
          {drillingTasks.length > 0 && isMobile && (
            // На телефоне пять сегментов превращаются в один выпадающий список
            <select
              aria-label="Фильтр скважин"
              value={statusFilter}
              style={{ marginBottom: 12 }}
              onChange={(e) => {
                const next = new URLSearchParams(searchParams)
                if (e.target.value === 'all') next.delete('filter')
                else next.set('filter', e.target.value)
                setSearchParams(next, { replace: true })
              }}
            >
              {(
                [
                  ['all', 'Все'],
                  ['planned', 'Запланированные'],
                  ['in_progress', 'В работе'],
                  ['suspended', 'Приостановленные'],
                  ['completed', 'Закрытые'],
                ] as const
              ).map(([key, label]) => (
                <option key={key} value={key}>
                  {label} ({key === 'all' ? drillingTasks.length : drillingTasks.filter((t) => t.status === key).length})
                </option>
              ))}
            </select>
          )}
          {drillingTasks.length > 0 && !isMobile && (
            <div className="map-segment" role="group" aria-label="Фильтр скважин" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
              {(
                [
                  ['all', 'Все'],
                  ['planned', 'Запланированные'],
                  ['in_progress', 'В работе'],
                  ['suspended', 'Приостановленные'],
                  ['completed', 'Закрытые'],
                ] as const
              ).map(([key, label]) => {
                const count = key === 'all' ? drillingTasks.length : drillingTasks.filter((t) => t.status === key).length
                return (
                  <button
                    key={key}
                    type="button"
                    className={statusFilter === key ? 'is-active' : ''}
                    onClick={() => {
                      const next = new URLSearchParams(searchParams)
                      if (key === 'all') next.delete('filter')
                      else next.set('filter', key)
                      setSearchParams(next, { replace: true })
                    }}
                  >
                    {label} <span className="num" style={{ opacity: 0.75 }}>{count}</span>
                  </button>
                )
              })}
            </div>
          )}
          {drillingTasks.length === 0 ? (
            <p className="text-muted">Пока нет заданий на бурение.</p>
          ) : drillingTasks.filter((t) => statusFilter === 'all' || t.status === statusFilter).length === 0 ? (
            <p className="text-muted">Скважин в этом состоянии нет.</p>
          ) : (
            <div className="well-grid">
              {drillingTasks.filter((t) => statusFilter === 'all' || t.status === statusFilter).map((t, i) => {
                const attention = attentionCounts(t.id, 'drilling_task_id', reports)
                // Керн/распиловка/опробование, прицепленные ИМЕННО к этой
                // скважине (drilling_task_id совпадает) — показываем
                // вложенными в карточку скважины, а не отдельным списком
                // (см. отзыв 19.09.2026: одна физическая скважина — одна
                // карточка). Задания на скважине подрядчика (без
                // drilling_task_id) остаются отдельными списками ниже.
                const attachedRows: AttachedRow[] = [
                  ...coreTasks
                    .filter((c) => c.drilling_task_id === t.id)
                    .map((c) => ({
                      key: `core-description:${c.id}`,
                      taskType: 'core-description' as const,
                      taskId: c.id,
                      icon: Layers,
                      label: c.documentation_type === 'geological' ? 'Описание керна · геологическая' : 'Описание керна · геотехническая',
                      attention: attentionCounts(c.id, 'core_description_task_id', reports),
                      progress: coreProgress(c.id, reports),
                      plan: t.projected_depth,
                    })),
                  ...sawingTasks
                    .filter((s) => s.drilling_task_id === t.id)
                    .map((s) => ({
                      key: `core-sawing:${s.id}`,
                      taskType: 'core-sawing' as const,
                      taskId: s.id,
                      icon: Scissors,
                      label: 'Распиловка керна',
                      attention: attentionCounts(s.id, 'core_sawing_task_id', reports),
                      sawn: sawingProgress(s.id, reports),
                      plan: t.projected_depth,
                    })),
                  ...samplingTasks
                    .filter((s) => s.drilling_task_id === t.id)
                    .map((s) => ({
                      key: `sampling:${s.id}`,
                      taskType: 'sampling' as const,
                      taskId: s.id,
                      icon: FlaskConical,
                      label: 'Опробование',
                      attention: attentionCounts(s.id, 'sampling_task_id', reports),
                      samples: samplingProgress(s.id, reports),
                    })),
                ]
                return (
                  <motion.div
                    key={t.id}
                    className="card"
                    {...riseIn(i, { duration: 0.28, step: 0.03 })}
                    style={{ padding: 14 }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                      <Link
                        to={`/tasks/drilling/${t.id}/dashboard`}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14, flexWrap: 'wrap' }}
                      >
                        Скважина №{t.well_number}
                        <TaskStatusBadge status={t.status} closedReason={t.closed_reason} />
                      </Link>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {profile?.role === 'party_chief' && t.foreman_id === profile.id && (
                          <>
                            {/* Полевой режим (30.09.2026): новая сводка — одним касанием
                                прямо с карточки скважины, история — отдельной иконкой. */}
                            {t.status === 'completed' || t.closed_reason ? (
                              <button type="button" disabled title="Скважина закрыта — новые сводки не вносятся" style={{ fontSize: 13, padding: '8px 12px', minHeight: 40, display: 'flex', alignItems: 'center', gap: 5 }}>
                                <Plus size={15} /> Сводка
                              </button>
                            ) : (
                              <Link to={`/tasks/drilling/${t.id}/reports/new`}>
                                <button type="button" style={{ fontSize: 13, padding: '8px 12px', minHeight: 40, display: 'flex', alignItems: 'center', gap: 5 }}>
                                  <Plus size={15} /> Сводка
                                </button>
                              </Link>
                            )}
                            <Link to={`/tasks/drilling/${t.id}/reports`} title="История сводок" aria-label="История сводок" style={{ display: 'flex', padding: 8 }}>
                              <History size={18} className="text-faint" />
                            </Link>
                          </>
                        )}
                        {isManagement(profile?.role) && (
                          <Link to={`/sites/${siteId}/tasks/drilling/${t.id}/edit`} title="Редактировать задание">
                            <Pencil size={16} className="text-faint" />
                          </Link>
                        )}
                        <Link to={`/tasks/drilling/${t.id}/dashboard`} style={{ display: 'flex' }}>
                          <ChevronRight size={17} className="text-faint" />
                        </Link>
                      </div>
                    </div>
                    <AttentionBadges submitted={attention.submitted} rejected={attention.rejected} />
                    {t.status === 'planned' && (
                      <div style={{ marginTop: 6, display: 'grid', gap: 8 }}>
                        <dl className="map-card-facts">
                          {t.projected_depth != null && (
                            <div><dt>Проектная глубина</dt><dd className="num">{t.projected_depth} м</dd></div>
                          )}
                          {t.coord_wgs84_lat != null && t.coord_wgs84_lon != null && (
                            <div><dt>WGS-84</dt><dd className="num">{t.coord_wgs84_lat}; {t.coord_wgs84_lon}</dd></div>
                          )}
                          {t.angle != null && (
                            <div><dt>Угол / азимут</dt><dd className="num">{t.angle}° / {t.azimuth ?? '—'}°</dd></div>
                          )}
                          <div>
                            <dt>Запланирована</dt>
                            <dd>
                              {t.created_at.slice(8, 10)}.{t.created_at.slice(5, 7)}.{t.created_at.slice(0, 4)}
                              {authorNames[t.created_by] ? ` · ${authorNames[t.created_by]}` : ''}
                            </dd>
                          </div>
                        </dl>
                        {t.description && (
                          <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
                            {t.description.length > 140 ? `${t.description.slice(0, 140)}…` : t.description}
                          </p>
                        )}
                        {isManagement(profile?.role) && (
                          <button type="button" onClick={() => setStartingWell(t)} style={{ display: 'flex', alignItems: 'center', gap: 6, justifySelf: 'start' }}>
                            <Play size={14} /> Запустить бурение
                          </button>
                        )}
                      </div>
                    )}
                    {t.status !== 'planned' && t.projected_depth != null && (
                      <div style={{ marginTop: 8 }}>
                        <ProgressBar
                          label="Метраж бурения"
                          approved={foreignProgress[t.id] ?? drillingProgress(t.id, reports)}
                          plan={t.projected_depth}
                        />
                      </div>
                    )}

                    {attachedRows.length > 0 && (
                      <div className="attached-row-list">
                        {attachedRows.map((row) => (
                          <div key={row.key} className="attached-row">
                            <div className="attached-row-header">
                              <row.icon size={14} className="text-muted" />
                              <span>{row.label}</span>
                              <AttentionBadges submitted={row.attention.submitted} rejected={row.attention.rejected} />
                              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                                {profile?.role === 'party_chief' && (
                                  <Link to={`/tasks/${row.taskType}/${row.taskId}/reports`}>
                                    <button type="button" style={{ fontSize: 12, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
                                      <FileText size={11} /> Сводка
                                    </button>
                                  </Link>
                                )}
                                <Link to={`/tasks/${row.taskType}/${row.taskId}/dashboard`} style={{ display: 'flex' }}>
                                  <ChevronRight size={15} className="text-faint" />
                                </Link>
                              </div>
                            </div>
                            {'progress' in row && (
                              <div style={{ marginTop: 6 }}>
                                <ProgressBar label="Керн описан" approved={row.progress.core} plan={row.plan} />
                                <ProgressBar label="Фотофиксация" approved={row.progress.photo} plan={row.plan} />
                              </div>
                            )}
                            {'sawn' in row && (
                              <div style={{ marginTop: 6 }}>
                                <ProgressBar label="Распилено" approved={row.sawn} plan={row.plan} />
                              </div>
                            )}
                            {'samples' in row && (
                              <p className="text-muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
                                Проб отобрано: <span className="num text-success">{row.samples.taken}</span>
                                {' · '}
                                сдано в лабораторию: <span className="num text-success">{row.samples.submitted}</span>
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )
              })}
            </div>
          )}

          {externalCoreTasks.length > 0 && (
            <>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Layers size={18} className="text-muted" /> Описание керна (скважина подрядчика)
              </h2>
              <div style={{ display: 'grid', gap: 10 }}>
                {externalCoreTasks.map((t, i) => {
                  const attention = attentionCounts(t.id, 'core_description_task_id', reports)
                  const progress = coreProgress(t.id, reports)
                  return (
                    <motion.div
                      key={t.id}
                      className="card"
                      {...riseIn(i, { duration: 0.28, step: 0.03 })}
                      style={{ padding: 14 }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                        <Link
                          to={`/tasks/core-description/${t.id}/dashboard`}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14, flexWrap: 'wrap' }}
                        >
                          {`Скважина подрядчика №${t.external_well_number}`}
                          <span className="badge badge-neutral">
                            {t.documentation_type === 'geological' ? 'геологическая' : 'геотехническая'}
                          </span>
                          {!t.shift_enabled && <span className="badge badge-neutral">без смен</span>}
                        </Link>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {profile?.role === 'party_chief' && (
                            <Link to={`/tasks/core-description/${t.id}/reports`}>
                              <button type="button" style={{ fontSize: 12, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 5 }}>
                                <FileText size={13} /> Сводка
                              </button>
                            </Link>
                          )}
                          {isManagement(profile?.role) && (
                            <Link to={`/sites/${siteId}/tasks/core-description/${t.id}/edit`} title="Редактировать задание">
                              <Pencil size={16} className="text-faint" />
                            </Link>
                          )}
                          <Link to={`/tasks/core-description/${t.id}/dashboard`} style={{ display: 'flex' }}>
                            <ChevronRight size={17} className="text-faint" />
                          </Link>
                        </div>
                      </div>
                      <AttentionBadges submitted={attention.submitted} rejected={attention.rejected} />
                      <div style={{ marginTop: 8 }}>
                        <ProgressBar label="Керн описан" approved={progress.core} plan={t.external_projected_depth} />
                        <ProgressBar label="Фотофиксация" approved={progress.photo} plan={t.external_projected_depth} />
                      </div>
                    </motion.div>
                  )
                })}
              </div>
            </>
          )}

          {externalSamplingTasks.length > 0 && (
            <>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FlaskConical size={18} className="text-muted" /> Опробование (скважина подрядчика)
              </h2>
              <div style={{ display: 'grid', gap: 10 }}>
                {externalSamplingTasks.map((t, i) => {
                  const attention = attentionCounts(t.id, 'sampling_task_id', reports)
                  const progress = samplingProgress(t.id, reports)
                  return (
                    <motion.div
                      key={t.id}
                      className="card"
                      {...riseIn(i, { duration: 0.28, step: 0.03 })}
                      style={{ padding: 14 }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                        <Link
                          to={`/tasks/sampling/${t.id}/dashboard`}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}
                        >
                          {`Скважина подрядчика №${t.external_well_number}`}
                        </Link>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {profile?.role === 'party_chief' && (
                            <Link to={`/tasks/sampling/${t.id}/reports`}>
                              <button type="button" style={{ fontSize: 12, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 5 }}>
                                <FileText size={13} /> Сводка
                              </button>
                            </Link>
                          )}
                          {isManagement(profile?.role) && (
                            <Link to={`/sites/${siteId}/tasks/sampling/${t.id}/edit`} title="Редактировать задание">
                              <Pencil size={16} className="text-faint" />
                            </Link>
                          )}
                          <Link to={`/tasks/sampling/${t.id}/dashboard`} style={{ display: 'flex' }}>
                            <ChevronRight size={17} className="text-faint" />
                          </Link>
                        </div>
                      </div>
                      <AttentionBadges submitted={attention.submitted} rejected={attention.rejected} />
                      <p className="text-muted" style={{ fontSize: 13, margin: '8px 0 0' }}>
                        Проб отобрано: <span className="num text-success">{progress.taken}</span>
                        {' · '}
                        сдано в лабораторию: <span className="num text-success">{progress.submitted}</span>
                      </p>
                    </motion.div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
