import { useEffect, useState } from 'react'
import { useWellHasCrew } from '../../hooks/useWellHasCrew'
import { Link, Navigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ChevronLeft,
  TrendingUp,
  TrendingDown,
  Minus,
  MessageSquare,
  Layers,
  HardHat,
  Pencil,
  Scissors,
  FlaskConical,
  Plus,
  Users,
  Lock,
  Unlock,
  FileText,
} from 'lucide-react'
import DerrickIcon from '../../components/icons/DerrickIcon'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../context/AuthContext'
import { isManagement } from '../../types/roles'
import { riseIn } from '../../lib/motionVariants'
import { round2 } from '../../lib/taskProgress'
import ProgressBar from '../../components/ProgressBar'
import DrillingProgressPanel, { type DrillingChartRow } from '../../components/DrillingProgressPanel'
import CrewAssignmentSection from '../../components/CrewAssignmentSection'
import Modal from '../../components/Modal'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { TASK_TYPE_REPORT_COLUMN, TASK_TYPE_LABELS, type TaskType } from '../../types/taskType'
import { CLOSED_REASON_LABELS } from '../../types/database'
import type {
  ClosedReason,
  CoreDescriptionTask,
  CoreSawingTask,
  DrillingTask,
  Profile,
  Report,
  SamplingTask,
} from '../../types/database'
import { shortName } from '../../lib/shortName'

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}
function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function dayIndex(startIso: string, iso: string) {
  return Math.round(
    (new Date(`${iso}T00:00:00Z`).getTime() - new Date(`${startIso}T00:00:00Z`).getTime()) /
      86_400_000,
  )
}

interface ShiftCell {
  report: Report | null
}
interface DayRow {
  date: string
  shift1: ShiftCell
  shift2: ShiftCell
  noShift: ShiftCell // для заданий без деления на смены
}

// Единая "рабочая" сводка для смены: в норме на (дата, смена) ровно одна
// строка reports (правки идут через update того же id, см. ТЗ) — если
// исторически оказалось несколько, берём последнюю по updated_at.
function pickReport(reports: Report[]): Report | null {
  if (reports.length === 0) return null
  return reports.reduce((a, b) => (a.updated_at > b.updated_at ? a : b))
}

function paceLabel(diff: number, plan: number) {
  if (plan <= 0) return { text: '—', variant: 'neutral' as const }
  const pct = (diff / plan) * 100
  if (Math.abs(diff) < 0.25) return { text: 'по плану', variant: 'neutral' as const }
  if (diff > 0)
    return { text: `опережаем на ${diff.toFixed(1)} м (${pct.toFixed(0)}%)`, variant: 'success' as const }
  return { text: `отстаём на ${Math.abs(diff).toFixed(1)} м (${Math.abs(pct).toFixed(0)}%)`, variant: 'danger' as const }
}

const TASK_ICON: Record<TaskType, typeof Layers> = {
  drilling: DerrickIcon as unknown as typeof Layers,
  'core-description': Layers,
  'core-sawing': Scissors,
  sampling: FlaskConical,
}

// Дашборд задания — общий для всех 4 видов (бурение, описание керна,
// распиловка, опробование, см. миграцию 0007). Бурение и распиловка —
// метраж накапливается аддитивно посменно, у обоих есть накопительный
// факт в таблице по дням; план/темп/отклонение — только у бурения (у
// распиловки своего planned_daily_meters нет, не придумываем). Описание
// керна — интервалы (кумулятивные "от-до"), не аддитивные, показываются
// прогресс-барами без таблицы накопления. Опробование — без смен вообще,
// два независимых счётчика (отобрано / сдано в лабораторию).
export default function TaskDashboard() {
  const { taskType, taskId } = useParams<{ taskType: TaskType; taskId: string }>()
  const { session, profile, canCreateWells, loading: authLoading } = useAuth()

  // Таблица "По дням": на телефоне свёрнута по умолчанию (полевому работнику
  // нужны забой и прогресс, а не вся история), на ПК развёрнута.
  const isMobile = useIsMobile()
  const [daysOpen, setDaysOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 768px)').matches,
  )
  const [commentsOpen, setCommentsOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 768px)').matches,
  )
  const [drillingTask, setDrillingTask] = useState<DrillingTask | null>(null)
  const [coreTask, setCoreTask] = useState<CoreDescriptionTask | null>(null)
  const [sawingTask, setSawingTask] = useState<CoreSawingTask | null>(null)
  const [samplingTask, setSamplingTask] = useState<SamplingTask | null>(null)
  const [linkedDrillingTask, setLinkedDrillingTask] = useState<DrillingTask | null>(null)
  const [foreman, setForeman] = useState<Profile | null>(null)
  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Работы, прицепленные к ЭТОЙ скважине бурения (см. отзыв 19.09.2026) —
  // нужны здесь только чтобы показать их в единой модалке "Состав
  // бригады" вместе с самим бурением (отзыв 20.09.2026: раньше назначить
  // ответственного исполнителя на них было негде найти).
  const [attachedGeoCore, setAttachedGeoCore] = useState<CoreDescriptionTask | null>(null)
  const [attachedGeotechCore, setAttachedGeotechCore] = useState<CoreDescriptionTask | null>(null)
  const [attachedSawing, setAttachedSawing] = useState<CoreSawingTask | null>(null)
  const [attachedSampling, setAttachedSampling] = useState<SamplingTask | null>(null)
  const [crewOpen, setCrewOpen] = useState(false)
  // Закрытие скважины (03.10.2026)
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeReason, setCloseReason] = useState<ClosedReason>('depth_reached')
  const [closeNote, setCloseNote] = useState('')
  const [closeDate, setCloseDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [closeBusy, setCloseBusy] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)

  const [planDraft, setPlanDraft] = useState('')
  const [editingPlan, setEditingPlan] = useState(false)
  const [savingPlan, setSavingPlan] = useState(false)

  const isDrilling = taskType === 'drilling'
  const hasCrew = useWellHasCrew(taskId, isDrilling && profile?.role === 'party_chief')
  const isCoreDescription = taskType === 'core-description'
  const isSawing = taskType === 'core-sawing'
  const isSampling = taskType === 'sampling'
  // Метраж накапливается посменно простым сложением (в отличие от
  // core-description, где хранятся интервалы "от-до").
  const isAdditiveMeters = isDrilling || isSawing

  useEffect(() => {
    if (!session || !taskId || !taskType) return
    const currentTaskType = taskType

    async function load() {
      setLoading(true)
      setError(null)

      let foremanId: string | null = null

      if (taskType === 'drilling') {
        const { data, error: taskError } = await supabase
          .from('drilling_tasks')
          .select('*')
          .eq('id', taskId)
          .single()
        if (taskError) setError(taskError.message)
        setDrillingTask(data)
        foremanId = data?.foreman_id ?? null

        const [coreRes, sawingRes, samplingRes] = await Promise.all([
          supabase.from('core_description_tasks').select('*').eq('drilling_task_id', taskId),
          supabase.from('core_sawing_tasks').select('*').eq('drilling_task_id', taskId).maybeSingle(),
          supabase.from('sampling_tasks').select('*').eq('drilling_task_id', taskId).maybeSingle(),
        ])
        setAttachedGeoCore(coreRes.data?.find((t) => t.documentation_type === 'geological') ?? null)
        setAttachedGeotechCore(coreRes.data?.find((t) => t.documentation_type === 'geotechnical') ?? null)
        setAttachedSawing(sawingRes.data ?? null)
        setAttachedSampling(samplingRes.data ?? null)
      } else if (taskType === 'core-description') {
        const { data, error: taskError } = await supabase
          .from('core_description_tasks')
          .select('*')
          .eq('id', taskId)
          .single()
        if (taskError) setError(taskError.message)
        setCoreTask(data)
        if (data?.drilling_task_id) {
          const { data: linked } = await supabase
            .from('drilling_tasks')
            .select('*')
            .eq('id', data.drilling_task_id)
            .single()
          setLinkedDrillingTask(linked)
          foremanId = linked?.foreman_id ?? null
        } else {
          foremanId = data?.assigned_party_chief_id ?? null
        }
      } else if (taskType === 'core-sawing') {
        const { data, error: taskError } = await supabase
          .from('core_sawing_tasks')
          .select('*')
          .eq('id', taskId)
          .single()
        if (taskError) setError(taskError.message)
        setSawingTask(data)
        if (data?.drilling_task_id) {
          const { data: linked } = await supabase
            .from('drilling_tasks')
            .select('*')
            .eq('id', data.drilling_task_id)
            .single()
          setLinkedDrillingTask(linked)
          foremanId = linked?.foreman_id ?? null
        }
      } else if (taskType === 'sampling') {
        const { data, error: taskError } = await supabase
          .from('sampling_tasks')
          .select('*')
          .eq('id', taskId)
          .single()
        if (taskError) setError(taskError.message)
        setSamplingTask(data)
        foremanId = data?.assigned_party_chief_id ?? null
        if (data?.drilling_task_id) {
          const { data: linked } = await supabase
            .from('drilling_tasks')
            .select('*')
            .eq('id', data.drilling_task_id)
            .single()
          setLinkedDrillingTask(linked)
        }
      }

      if (foremanId) {
        const { data: foremanProfile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', foremanId)
          .single()
        setForeman(foremanProfile)
      }

      const column = TASK_TYPE_REPORT_COLUMN[currentTaskType]
      const { data: reportRows, error: reportsError } = await supabase
        .from('reports')
        .select('*')
        .eq(column, taskId)
        .order('report_date', { ascending: true })
      if (reportsError) setError(reportsError.message)
      setReports(reportRows ?? [])

      setLoading(false)
    }

    load()
  }, [session, taskId, taskType])

  async function savePlan() {
    if (!drillingTask) return
    setSavingPlan(true)
    const value = planDraft ? Number(planDraft) : null
    const { error: updateError } = await supabase
      .from('drilling_tasks')
      .update({ planned_daily_meters: value })
      .eq('id', drillingTask.id)
    setSavingPlan(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    setDrillingTask({ ...drillingTask, planned_daily_meters: value })
    setEditingPlan(false)
  }

  if (authLoading) return <p>Загрузка…</p>
  if (!session) return <Navigate to="/login" replace />
  if (!taskId || !taskType) return <p>Не указано задание.</p>
  if (loading) return <p>Загрузка…</p>
  if (error) return <p className="text-error">{error}</p>

  // Только номер скважины (07.10.2026): слово «скважина» в заголовке не нужно;
  // скважина подрядчика помечается словом «подрядчик».
  const wellLabel = isDrilling
    ? `№${drillingTask?.well_number ?? '…'}`
    : isCoreDescription
      ? coreTask?.drilling_task_id
        ? `№${linkedDrillingTask?.well_number ?? '…'}`
        : `Подрядчик №${coreTask?.external_well_number ?? '…'}`
      : isSawing
        ? `№${linkedDrillingTask?.well_number ?? '…'}`
        : samplingTask?.drilling_task_id
          ? `№${linkedDrillingTask?.well_number ?? '…'}`
          : `Подрядчик №${samplingTask?.external_well_number ?? '…'}`

  const siteId = drillingTask?.site_id ?? coreTask?.site_id ?? sawingTask?.site_id ?? samplingTask?.site_id

  const shiftsApply = isDrilling || isSawing ? true : isCoreDescription ? (coreTask?.shift_enabled ?? true) : false

  // План "на всю задачу": для бурения — своя проектная глубина; для
  // описания керна и распиловки — глубина связанной (своей или подрядчика)
  // скважины, так как обе идут вдоль того же ствола (см. дорожную карту).
  // У опробования плана нет — считать процент не от чего.
  const projectedDepth = isDrilling
    ? (drillingTask?.projected_depth ?? null)
    : isCoreDescription
      ? ((coreTask?.drilling_task_id ? linkedDrillingTask?.projected_depth : coreTask?.external_projected_depth) ?? null)
      : isSawing
        ? (linkedDrillingTask?.projected_depth ?? null)
        : null

  const plannedDailyMeters = isDrilling ? (drillingTask?.planned_daily_meters ?? null) : null

  const approvedReports = reports.filter((r) => r.approval_status === 'approved')
  const submittedReports = reports.filter((r) => r.approval_status === 'submitted')

  function additiveMetric(r: Report) {
    return isDrilling ? r.drilling_meters : isSawing ? r.sawn_meters : null
  }

  // ---- сводные прогресс-бары ----
  const approvedAdditiveMeters = round2(approvedReports.reduce((s, r) => s + (additiveMetric(r) ?? 0), 0))
  const pendingAdditiveMeters = round2(submittedReports.reduce((s, r) => s + (additiveMetric(r) ?? 0), 0))

  const approvedCoreTo = approvedReports.reduce(
    (max, r) => Math.max(max, r.core_description_interval_to ?? 0),
    0,
  )
  const approvedPhotoTo = approvedReports.reduce(
    (max, r) => Math.max(max, r.photofixation_interval_to ?? 0),
    0,
  )

  const approvedSamplesTaken = approvedReports.reduce((s, r) => s + (r.samples_taken ?? 0), 0)
  const approvedSamplesSubmitted = approvedReports.reduce((s, r) => s + (r.samples_submitted ?? 0), 0)

  // ---- дневная таблица — показываем для всех видов задания; у описания
  //      керна нет аддитивных накопительных колонок (интервалы "от-до",
  //      не сумма), но сама таблица по сменам всё равно полезна ----
  const startDate =
    (isDrilling ? drillingTask?.start_date : undefined) ?? reports[0]?.report_date ?? todayIso()
  const lastReportDate = reports.reduce<string | null>(
    (max, r) => (max == null || r.report_date > max ? r.report_date : max),
    null,
  )
  // Таблица "По дням" растёт вместе с календарём ТОЛЬКО пока скважина в
  // работе. Для запланированной / приостановленной / завершённой строки
  // после последней сводки не добавляются (30.09.2026, по запросу
  // владельца) — иначе набегают пустые "0 м" и страница на телефоне
  // растягивается на тысячи пикселей. У заданий без своего статуса
  // (керн/распиловка/опробование) берём статус связанной скважины.
  const effectiveStatus =
    drillingTask?.status ?? linkedDrillingTask?.status ?? 'in_progress'
  const isActiveStatus = effectiveStatus === 'in_progress'
  // Закрытая скважина (по любой причине): мастер больше не вносит сводки и не правит состав бригады
  const wellClosed = isDrilling && !!drillingTask && (drillingTask.status === 'completed' || !!drillingTask.closed_reason)
  const chiefBlocked = wellClosed && profile?.role === 'party_chief'
  const lastDate = isActiveStatus
    ? lastReportDate && lastReportDate > todayIso()
      ? lastReportDate
      : todayIso()
    : (() => {
        const base = lastReportDate ?? startDate
        const closedAt = drillingTask?.closed_at
        return closedAt && closedAt > base ? closedAt : base
      })()
  const totalDays = !isActiveStatus && lastReportDate == null ? -1 : Math.max(0, dayIndex(startDate, lastDate))

  const byKey = new Map<string, Report[]>()
  for (const r of reports) {
    const key = `${r.report_date}|${r.shift_number ?? '_'}`
    byKey.set(key, [...(byKey.get(key) ?? []), r])
  }

  const dayRows: DayRow[] = []
  for (let i = 0; i <= totalDays; i++) {
    const date = addDays(startDate, i)
    dayRows.push({
      date,
      shift1: { report: pickReport(byKey.get(`${date}|1`) ?? []) },
      shift2: { report: pickReport(byKey.get(`${date}|2`) ?? []) },
      noShift: { report: pickReport(byKey.get(`${date}|_`) ?? []) },
    })
  }

  interface CellInfo {
    meters: number | null
    hours: number | null
    status: Report['approval_status'] | null
    notes: string | null
    samplesTaken: number | null
    samplesSubmitted: number | null
  }

  function cellValue(cell: ShiftCell): CellInfo {
    if (!cell.report) {
      return { meters: null, hours: null, status: null, notes: null, samplesTaken: null, samplesSubmitted: null }
    }
    const r = cell.report
    const meters = isAdditiveMeters
      ? additiveMetric(r)
      : isCoreDescription && r.core_description_interval_to != null && r.core_description_interval_from != null
        ? r.core_description_interval_to - r.core_description_interval_from
        : null
    return {
      meters: meters != null ? round2(meters) : null,
      hours: r.hours_worked,
      status: r.approval_status,
      notes: r.shift_notes,
      samplesTaken: r.samples_taken,
      samplesSubmitted: r.samples_submitted,
    }
  }

  let runningApproved = 0
  // Отдельно от "подтверждено" (runningApproved) — "известно" (подтверждено
  // + ещё на согласовании), нужно для графика проходки (25.09.2026, панель
  // с накопленной линией факта): пока обычно совпадает с runningApproved,
  // расходится только на "хвосте" из ещё не одобренных смен.
  let runningKnown = 0
  const rowsRendered = dayRows.map((row) => {
    const cells = shiftsApply ? [cellValue(row.shift1), cellValue(row.shift2)] : [cellValue(row.noShift)]

    const dayApproved = isAdditiveMeters
      ? round2(cells.reduce((s, c) => s + (c.status === 'approved' ? (c.meters ?? 0) : 0), 0))
      : 0
    runningApproved = round2(runningApproved + dayApproved)

    const dayKnown = isAdditiveMeters
      ? round2(
          cells.reduce(
            (s, c) => s + (c.status === 'approved' || c.status === 'submitted' ? (c.meters ?? 0) : 0),
            0,
          ),
        )
      : 0
    runningKnown = round2(runningKnown + dayKnown)

    const daySamplesTaken = isSampling
      ? cells.reduce((s, c) => s + (c.status === 'approved' ? (c.samplesTaken ?? 0) : 0), 0)
      : 0

    const plannedCumulative =
      isDrilling && plannedDailyMeters != null && projectedDepth != null
        ? round2(Math.min(plannedDailyMeters * (dayIndex(startDate, row.date) + 1), projectedDepth))
        : null

    return { row, cells, dayApproved, runningApproved, runningKnown, daySamplesTaken, plannedCumulative }
  })

  const latestPlanned = rowsRendered[rowsRendered.length - 1]?.plannedCumulative ?? null
  // Если проектная глубина уже достигнута, "опережаем на N м" вводит в заблуждение
  // (сравнение с календарным планом на сегодня) — показываем "план выполнен".
  const planDone = projectedDepth != null && approvedAdditiveMeters >= projectedDepth
  const pace =
    isDrilling && planDone
      ? { text: 'план выполнен', variant: 'success' as const }
      : isDrilling && latestPlanned != null
        ? paceLabel(approvedAdditiveMeters - latestPlanned, latestPlanned)
        : null
  const overallPercent = isAdditiveMeters && projectedDepth ? (approvedAdditiveMeters / projectedDepth) * 100 : null
  const rowsForDisplay = [...rowsRendered].reverse()

  // ---- панель "Проходка скважины" (25.09.2026, редизайн) — темп/прогноз/
  //      счётчики и данные графика по сменам, см. DrillingProgressPanel.tsx ----
  const daysElapsed = totalDays + 1
  const paceRate = isDrilling && daysElapsed > 0 ? round2(approvedAdditiveMeters / daysElapsed) : 0
  const forecastLabel =
    isDrilling && projectedDepth != null
      ? (() => {
          const remaining = round2(projectedDepth - approvedAdditiveMeters)
          if (remaining <= 0) return 'готово'
          if (paceRate <= 0) return null
          const daysNeeded = Math.ceil(remaining / paceRate)
          const iso = addDays(todayIso(), daysNeeded)
          return `≈ ${iso.slice(8, 10)}.${iso.slice(5, 7)}`
        })()
      : null
  const shiftsCount = reports.length
  const chartRows: DrillingChartRow[] = isDrilling
    ? rowsRendered.map(({ row, cells, runningApproved: cumApproved, runningKnown: cumKnown, plannedCumulative }) => ({
        date: row.date,
        shift1: cells[0]?.meters ?? null,
        shift1Approved: cells[0]?.status === 'approved',
        shift2: cells[1]?.meters ?? null,
        shift2Approved: cells[1]?.status === 'approved',
        cumApproved,
        cumKnown,
        plannedCumulative,
      }))
    : []

  async function handleCloseWell() {
    if (!drillingTask) return
    if (closeReason === 'other' && !closeNote.trim()) {
      setCloseError('Укажите причину закрытия.')
      return
    }
    if (!closeDate) {
      setCloseError('Укажите дату закрытия.')
      return
    }
    if (closeDate > todayIso()) {
      setCloseError('Дата закрытия не может быть в будущем.')
      return
    }
    if (drillingTask.start_date && closeDate < drillingTask.start_date) {
      setCloseError('Дата закрытия раньше начала бурения.')
      return
    }
    setCloseBusy(true)
    setCloseError(null)
    const { data, error: updError } = await supabase
      .from('drilling_tasks')
      .update({
        status: 'completed',
        closed_reason: closeReason,
        closed_note: closeNote.trim() || null,
        closed_at: closeDate,
      })
      .eq('id', drillingTask.id)
      .select()
    setCloseBusy(false)
    if (updError) {
      setCloseError(
        updError.message.includes('closed_')
          ? 'Не применена миграция 0023 (поля закрытия скважины). Примените её в Supabase SQL Editor.'
          : updError.message,
      )
      return
    }
    if (!data || data.length === 0) {
      setCloseError('Не удалось закрыть скважину: нет прав на изменение.')
      return
    }
    setDrillingTask(data[0] as DrillingTask)
    setCloseOpen(false)
    setCloseNote('')
  }

  async function handleReopenWell() {
    if (!drillingTask) return
    setCloseBusy(true)
    const { data, error: updError } = await supabase
      .from('drilling_tasks')
      .update({ status: 'in_progress', closed_reason: null, closed_note: null, closed_at: null })
      .eq('id', drillingTask.id)
      .select()
    setCloseBusy(false)
    if (updError || !data || data.length === 0) {
      setError(updError?.message ?? 'Не удалось возобновить скважину.')
      return
    }
    setDrillingTask(data[0] as DrillingTask)
  }

  const closure =
    isDrilling && drillingTask?.closed_reason
      ? {
          date: drillingTask.closed_at ?? todayIso(),
          kind: drillingTask.closed_reason === 'depth_reached' ? ('depth_reached' as const) : ('other' as const),
          label:
            drillingTask.closed_reason === 'depth_reached'
              ? 'Глубина достигнута'
              : drillingTask.closed_reason === 'accident'
                ? 'Авария'
                : 'Закрыта',
        }
      : null

  const PaceIcon = pace?.variant === 'success' ? TrendingUp : pace?.variant === 'danger' ? TrendingDown : Minus
  const paceColors: Record<'success' | 'danger' | 'neutral', { bg: string; fg: string }> = {
    success: { bg: 'var(--color-success-soft)', fg: 'var(--color-success)' },
    danger: { bg: 'var(--color-danger-soft)', fg: 'var(--color-danger)' },
    neutral: { bg: 'var(--color-surface-muted)', fg: 'var(--color-text-muted)' },
  }

  function shiftColumnLabel(index: 0 | 1) {
    if (isSawing) return index === 0 ? 'День' : 'Ночь'
    return `Смена ${index + 1}`
  }

  const TaskIcon = TASK_ICON[taskType]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {siteId && (
            <div style={{ marginBottom: 12 }}>
              <Link to={`/sites/${siteId}`}>
                <button
                  type="button"
                  className="btn-outline"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap' }}
                >
                  <ChevronLeft size={15} /> К участку
                </button>
              </Link>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                background: isDrilling ? 'var(--color-primary-soft)' : 'var(--color-accent-soft)',
                color: isDrilling ? 'var(--color-primary)' : 'var(--color-accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <TaskIcon size={18} />
            </span>
            <h1 style={{ margin: 0, minWidth: 0, fontSize: 22, fontStyle: 'italic', fontWeight: 700, overflowWrap: 'anywhere' }}>
              {wellLabel}
            </h1>
          </div>
          <p className="eyebrow" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {TASK_TYPE_LABELS[taskType]}
            {isCoreDescription && coreTask && (
              <span className="badge badge-neutral">
                {coreTask.documentation_type === 'geological' ? 'геологическая' : 'геотехническая'}
              </span>
            )}
            {foreman && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--color-text-muted)' }}>
                <HardHat size={13} /> {shortName(foreman.full_name)}
              </span>
            )}
          </p>
        </div>

        {/* Кнопки действий — столбиком справа, одинаковой ширины */}
        <div style={{ width: 152, flexShrink: 0, display: 'grid', gap: 8 }}>
          {profile?.role === 'party_chief' &&
            (chiefBlocked ? (
              <button type="button" disabled title="Скважина закрыта — новые сводки не вносятся" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap', width: '100%' }}>
                <Plus size={15} /> Новая сводка
              </button>
            ) : isDrilling && hasCrew === false ? (
              <Link to="/my-crew" style={{ display: 'block' }}>
                <button type="button" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap', width: '100%' }} title="Пока не составлена бригада, сводки недоступны">
                  <Users size={15} /> Составить бригаду
                </button>
              </Link>
            ) : (
              <Link to={`/tasks/${taskType}/${taskId}/reports/new`} style={{ display: 'block' }}>
                <button type="button" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap', width: '100%' }}>
                  <Plus size={15} /> Новая сводка
                </button>
              </Link>
            ))}
          <Link to={`/tasks/${taskType}/${taskId}/reports`} style={{ display: 'block' }}>
            <button type="button" className="btn-outline" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap', width: '100%' }}>
              <FileText size={15} /> Все сводки
            </button>
          </Link>
          <button type="button" className="btn-outline" disabled={chiefBlocked} title={chiefBlocked ? 'Скважина закрыта — состав бригады недоступен' : undefined} onClick={() => setCrewOpen(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap', width: '100%' }}>
            <Users size={15} /> Состав бригады
          </button>
          {/* Редактирование задания — руководству, для всех четырёх видов заданий */}
          {(isManagement(profile?.role) || (isDrilling && canCreateWells && drillingTask?.created_by === profile?.id && drillingTask?.foreman_id === profile?.id)) && siteId && (
            <Link to={`/sites/${siteId}/tasks/${taskType}/${taskId}/edit`} style={{ display: 'block' }}>
              <button type="button" className="btn-outline" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap', width: '100%' }}>
                <Pencil size={15} /> Редактировать
              </button>
            </Link>
          )}
          {isDrilling && drillingTask && isManagement(profile?.role) && !drillingTask.closed_reason && (
            <button
              type="button"
              className="btn-outline"
              onClick={() => {
                setCloseError(null)
                setCloseDate(todayIso())
                setCloseOpen(true)
              }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap', width: '100%' }}
            >
              <Lock size={15} /> Закрыть скважину
            </button>
          )}
        </div>
      </div>

      {isDrilling && drillingTask?.closed_reason && (
        <div
          className="card"
          style={{
            padding: 12,
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            borderColor: drillingTask.closed_reason === 'depth_reached' ? 'var(--color-success)' : 'var(--color-danger)',
          }}
        >
          <Lock size={16} color={drillingTask.closed_reason === 'depth_reached' ? 'var(--color-success)' : 'var(--color-danger)'} />
          <span style={{ flex: 1, minWidth: 200 }}>
            <b>Скважина закрыта</b>
            {drillingTask.closed_at && <span className="text-muted"> · {drillingTask.closed_at.slice(8, 10)}.{drillingTask.closed_at.slice(5, 7)}.{drillingTask.closed_at.slice(0, 4)}</span>}
            <br />
            <span className="text-muted" style={{ fontSize: 13 }}>
              {CLOSED_REASON_LABELS[drillingTask.closed_reason]}
              {drillingTask.closed_note ? `: ${drillingTask.closed_note}` : ''}
            </span>
          </span>
          {isManagement(profile?.role) && (
            <button
              type="button"
              className="btn-outline"
              disabled={closeBusy}
              onClick={handleReopenWell}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
            >
              <Unlock size={14} /> {closeBusy ? 'Возобновляем…' : 'Возобновить'}
            </button>
          )}
        </div>
      )}

      <Modal open={closeOpen} onClose={() => setCloseOpen(false)} title="Закрыть скважину">
        <div style={{ display: 'grid', gap: 12 }}>
          <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
            Укажите причину. Новые дни в таблицу «По дням» после закрытия не добавляются, на графике отметится линия закрытия.
          </p>
          {(['depth_reached', 'accident', 'other'] as ClosedReason[]).map((r) => (
            <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, cursor: 'pointer' }}>
              <input
                type="radio"
                name="closeReason"
                checked={closeReason === r}
                onChange={() => setCloseReason(r)}
                style={{ width: 20, height: 20, flexShrink: 0 }}
              />
              {CLOSED_REASON_LABELS[r]}
            </label>
          ))}
          <label>
            Дата закрытия
            <input
              type="date"
              value={closeDate}
              max={todayIso()}
              min={drillingTask?.start_date ?? undefined}
              onChange={(e) => setCloseDate(e.target.value)}
            />
          </label>
          {(closeReason === 'other' || closeReason === 'accident') && (
            <textarea
              rows={3}
              placeholder={closeReason === 'other' ? 'Причина закрытия (обязательно)' : 'Комментарий к аварии (необязательно)'}
              value={closeNote}
              onChange={(e) => setCloseNote(e.target.value)}
            />
          )}
          {closeError && <p className="text-error" style={{ margin: 0 }}>{closeError}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={handleCloseWell} disabled={closeBusy}>
              {closeBusy ? 'Закрываем…' : 'Закрыть скважину'}
            </button>
            <button type="button" className="btn-outline" onClick={() => setCloseOpen(false)}>
              Отмена
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={crewOpen} onClose={() => setCrewOpen(false)} title="Состав бригады">
        <div style={{ display: 'grid', gap: 20 }}>
          <CrewAssignmentSection
            heading={isDrilling ? 'Бурение' : undefined}
            taskType={taskType}
            taskId={taskId}
            foremanId={foreman?.id ?? null}
            canEdit={!chiefBlocked && (isManagement(profile?.role) || (foreman != null && foreman.id === profile?.id))}
          />
          {isDrilling && attachedGeoCore && (
            <CrewAssignmentSection
              heading="Керн — геологическая документация"
              taskType="core-description"
              taskId={attachedGeoCore.id}
              foremanId={attachedGeoCore.assigned_party_chief_id ?? foreman?.id ?? null}
              canEdit={
                isManagement(profile?.role) ||
                (attachedGeoCore.assigned_party_chief_id ?? foreman?.id) === profile?.id
              }
            />
          )}
          {isDrilling && attachedGeotechCore && (
            <CrewAssignmentSection
              heading="Керн — геотехническая документация"
              taskType="core-description"
              taskId={attachedGeotechCore.id}
              foremanId={attachedGeotechCore.assigned_party_chief_id ?? foreman?.id ?? null}
              canEdit={
                isManagement(profile?.role) ||
                (attachedGeotechCore.assigned_party_chief_id ?? foreman?.id) === profile?.id
              }
            />
          )}
          {isDrilling && attachedSawing && (
            <CrewAssignmentSection
              heading="Распиловка керна"
              taskType="core-sawing"
              taskId={attachedSawing.id}
              foremanId={foreman?.id ?? null}
              canEdit={isManagement(profile?.role) || (foreman != null && foreman.id === profile?.id)}
            />
          )}
          {isDrilling && attachedSampling && (
            <CrewAssignmentSection
              heading="Опробование"
              taskType="sampling"
              taskId={attachedSampling.id}
              foremanId={attachedSampling.assigned_party_chief_id}
              canEdit={
                isManagement(profile?.role) || attachedSampling.assigned_party_chief_id === profile?.id
              }
            />
          )}
        </div>
      </Modal>

      {isDrilling ? (
        <motion.div {...riseIn(0, { y: 10, duration: 0.35 })}>
          <DrillingProgressPanel
            taskId={taskId}
            projectedDepth={projectedDepth}
            approvedDepth={approvedAdditiveMeters}
            pendingDepth={pendingAdditiveMeters}
            paceRate={paceRate}
            forecastLabel={forecastLabel}
            daysElapsed={daysElapsed}
            shiftsCount={shiftsCount}
            rows={chartRows}
            closure={closure}
            headerRight={
              <>
                {pendingAdditiveMeters > 0 && (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '8px 14px',
                      borderRadius: 'var(--radius-full)',
                      fontWeight: 700,
                      fontSize: 13,
                      background: 'var(--color-accent-soft)',
                      color: 'var(--color-accent)',
                    }}
                  >
                    на согласовании: +{pendingAdditiveMeters} м
                  </div>
                )}
                {pace && (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 14px',
                      borderRadius: 'var(--radius-full)',
                      fontWeight: 700,
                      fontSize: 13,
                      background: paceColors[pace.variant].bg,
                      color: paceColors[pace.variant].fg,
                    }}
                  >
                    <PaceIcon size={16} />
                    {pace.text}
                  </div>
                )}
              </>
            }
            planEditor={
              drillingTask && isManagement(profile?.role) ? (
                <div style={{ fontSize: 13 }}>
                  {editingPlan ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="number"
                        step="any"
                        autoFocus
                        value={planDraft}
                        onChange={(e) => setPlanDraft(e.target.value)}
                        placeholder="м/сутки"
                        style={{ width: 100, padding: '6px 8px' }}
                      />
                      <button type="button" onClick={savePlan} disabled={savingPlan} style={{ padding: '6px 10px', fontSize: 12 }}>
                        {savingPlan ? '…' : 'Сохранить'}
                      </button>
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={() => setEditingPlan(false)}
                        style={{ padding: '6px 10px', fontSize: 12 }}
                      >
                        Отмена
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn-outline"
                      onClick={() => {
                        setPlanDraft(drillingTask.planned_daily_meters != null ? String(drillingTask.planned_daily_meters) : '')
                        setEditingPlan(true)
                      }}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '6px 10px' }}
                    >
                      <Pencil size={12} />
                      {plannedDailyMeters != null ? `План: ${plannedDailyMeters} м/сутки` : 'Задать план бурения'}
                    </button>
                  )}
                </div>
              ) : undefined
            }
          />
        </motion.div>
      ) : isCoreDescription ? (
        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
          <ProgressBar label="Керн описан" approved={approvedCoreTo} plan={projectedDepth} />
          <ProgressBar label="Фотофиксация" approved={approvedPhotoTo} plan={projectedDepth} />
        </div>
      ) : isSawing ? (
        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
          {overallPercent != null && (
            <p style={{ margin: '0 0 10px' }}>
              <span className="badge badge-primary num">{overallPercent.toFixed(0)}% плана распилено</span>
            </p>
          )}
          <ProgressBar
            label="Распилено"
            approved={approvedAdditiveMeters}
            pending={pendingAdditiveMeters}
            plan={projectedDepth}
          />
        </div>
      ) : (
        <div className="card" style={{ padding: 20, marginBottom: 24, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 3 }}>
              Проб отобрано
            </div>
            <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>
              {approvedSamplesTaken}
            </div>
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 3 }}>
              Сдано в лабораторию
            </div>
            <div className="num" style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text-muted)' }}>
              {approvedSamplesSubmitted}
            </div>
          </div>
        </div>
      )}

      <>
          <h2 style={{ margin: '0 0 8px', fontSize: 14 }}>По дням {shiftsApply ? `(${shiftColumnLabel(0).toLowerCase()} / ${shiftColumnLabel(1).toLowerCase()})` : ''}</h2>
          <button
            type="button"
            className="btn-outline"
            onClick={() => setDaysOpen((v) => !v)}
            style={{ width: '100%', minHeight: 36, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}
          >
            {daysOpen ? 'Свернуть таблицу' : 'Показать таблицу'}
          </button>
          {!isActiveStatus && (
            <p className="text-muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
              Скважина не в работе — новые дни в таблицу не добавляются.
            </p>
          )}
          {isDrilling && plannedDailyMeters == null && (
            <p className="text-muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 12 }}>
              План бурения не задан — колонки «накопл. план» и «отклонение» пустые.
              {isManagement(profile?.role) ? ' Задайте его в блоке выше.' : ' Уточните у техдира.'}
            </p>
          )}
          {daysOpen && isMobile && (
            // Телефон: вместо широкой таблицы — карточки по дням (только дни со сводками и сегодня)
            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              {rowsForDisplay
                .filter(({ cells, row }) => row.date === todayIso() || cells.some((c) => c.meters != null || c.hours != null || c.samplesTaken != null))
                .map(({ row, cells, dayApproved, runningApproved: cumApproved, plannedCumulative }) => {
                  const dayDiff = plannedCumulative != null ? round2(cumApproved - plannedCumulative) : null
                  const isToday = row.date === todayIso()
                  return (
                    <div key={row.date} className="card" style={{ padding: 12, background: isToday ? 'var(--color-primary-soft)' : undefined }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                        <b className="num">{`${row.date.slice(8, 10)}.${row.date.slice(5, 7)}.${row.date.slice(0, 4)}`}</b>
                        {isAdditiveMeters && <span className="num" style={{ fontWeight: 700 }}>{dayApproved} м</span>}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
                        {cells.map((c, i) => (
                          <span key={i} className="badge badge-neutral num">
                            {shiftsApply ? `${shiftColumnLabel(i as 0 | 1)}: ` : ''}
                            {c.meters != null ? `${c.meters} м` : c.samplesTaken != null ? `${c.samplesTaken} проб` : '—'}
                            {c.hours != null ? ` · ${c.hours} ч` : ''}
                          </span>
                        ))}
                      </div>
                      {isAdditiveMeters && (
                        <div className="text-muted" style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: '2px 14px' }}>
                          <span>Накопл. факт: <b className="num">{cumApproved} м</b></span>
                          {isDrilling && plannedCumulative != null && <span>План: <b className="num">{plannedCumulative} м</b></span>}
                          {isDrilling && dayDiff != null && (
                            <span style={{ color: dayDiff >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                              {dayDiff >= 0 ? '+' : ''}{dayDiff} м
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>Дни без сводок скрыты.</p>
            </div>
          )}
          {daysOpen && !isMobile && (
          <div className="card" style={{ overflow: 'hidden', marginTop: 10 }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 480 }}>
                <thead>
                  <tr style={{ textAlign: 'left', background: 'var(--color-surface-muted)' }}>
                    <th style={{ padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-faint)' }}>Дата</th>
                    {shiftsApply ? (
                      <>
                        <th style={{ padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-faint)' }}>{shiftColumnLabel(0)}</th>
                        <th style={{ padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-faint)' }}>{shiftColumnLabel(1)}</th>
                      </>
                    ) : (
                      <th style={{ padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-faint)' }}>Сводка</th>
                    )}
                    {isAdditiveMeters && (
                      <>
                        <th style={{ padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-faint)' }}>Итого/день</th>
                        <th title="Сумма подтверждённых метров с начала задания по эту дату включительно" style={{ padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-faint)' }}>Накопл. факт</th>
                      </>
                    )}
                    {isDrilling && (
                      <>
                        <th title="Сколько должно быть пробурено к этой дате при темпе «план, м/сутки» из настроек задания" style={{ padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-faint)' }}>Накопл. план</th>
                        <th title="Накопл. факт минус накопл. план: плюс — опережаем, минус — отстаём" style={{ padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-faint)' }}>Отклонение</th>
                      </>
                    )}
                    {isSampling && (
                      <th style={{ padding: '10px 12px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-faint)' }}>Проб с начала</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rowsForDisplay.map(({ row, cells, dayApproved, runningApproved: cumApproved, daySamplesTaken, plannedCumulative }, rowIndex) => {
                    const dayDiff = plannedCumulative != null ? round2(cumApproved - plannedCumulative) : null
                    const isToday = row.date === todayIso()
                    return (
                      <tr
                        key={row.date}
                        style={{
                          borderTop: '1px solid var(--color-border)',
                          background: isToday ? 'var(--color-primary-soft)' : rowIndex % 2 === 1 ? 'var(--color-surface-muted)' : 'transparent',
                        }}
                      >
                        <td className="num" style={{ padding: '9px 12px', whiteSpace: 'nowrap', fontWeight: isToday ? 700 : 400 }}>
                          {`${row.date.slice(8, 10)}.${row.date.slice(5, 7)}.${row.date.slice(0, 4)}`}
                        </td>
                        {cells.map((c, i) => (
                          <td key={i} style={{ padding: '9px 12px' }}>
                            {c.meters == null && c.hours == null && c.samplesTaken == null ? (
                              <span className="text-faint">—</span>
                            ) : (
                              <>
                                {c.meters != null && <span className="num">{c.meters} м</span>}
                                {isSampling && c.samplesTaken != null && (
                                  <span className="num">
                                    {c.samplesTaken} проб
                                    {c.samplesSubmitted != null && ` (сдано: ${c.samplesSubmitted})`}
                                  </span>
                                )}
                                {c.hours != null && <span className="text-muted num"> · {c.hours} ч</span>}
                                {c.status && c.status !== 'approved' && (
                                  <span className={`badge badge-${c.status === 'submitted' ? 'primary' : c.status === 'rejected' ? 'danger' : 'neutral'}`} style={{ marginLeft: 6 }}>
                                    {c.status === 'submitted' ? 'на согл.' : c.status === 'rejected' ? 'отклонено' : 'черновик'}
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                        ))}
                        {isAdditiveMeters && (
                          <>
                            <td className="num" style={{ padding: '9px 12px', fontWeight: 600 }}>{dayApproved} м</td>
                            <td className="num" style={{ padding: '9px 12px' }}>{cumApproved} м</td>
                          </>
                        )}
                        {isDrilling && (
                          <>
                            <td className="num" style={{ padding: '9px 12px' }}>{plannedCumulative != null ? `${plannedCumulative.toFixed(2)} м` : '—'}</td>
                            <td className="num" style={{ padding: '9px 12px' }}>
                              {dayDiff != null ? (
                                <span className={dayDiff >= 0 ? 'text-success' : 'text-error'}>
                                  {dayDiff >= 0 ? '+' : ''}
                                  {dayDiff.toFixed(2)} м
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                          </>
                        )}
                        {isSampling && (
                          <td className="num" style={{ padding: '9px 12px', fontWeight: 600 }}>{daySamplesTaken}</td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          )}
      </>

      {rowsRendered.some(({ cells }) => cells.some((c) => c.notes)) && (
        <>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '20px 0 8px', fontSize: 14 }}>
            <MessageSquare size={16} className="text-muted" /> Комментарии бригадира по сменам
          </h2>
          <button
            type="button"
            className="btn-outline"
            onClick={() => setCommentsOpen((v) => !v)}
            style={{ width: '100%', minHeight: 36, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}
          >
            {commentsOpen ? 'Свернуть комментарии' : 'Показать комментарии'}
          </button>
          {commentsOpen && (
          <div className="card" style={{ padding: 4, fontSize: 13 }}>
            <ul>
              {rowsRendered.flatMap(({ row, cells }) =>
                cells
                  .map((c, i) => ({ c, i }))
                  .filter(({ c }) => c.notes)
                  .map(({ c, i }) => (
                    <li key={`${row.date}-${i}`} style={{ padding: '10px 12px' }}>
                      <b className="num">{row.date}</b>
                      {shiftsApply ? `, ${shiftColumnLabel(i as 0 | 1).toLowerCase()}` : ''} — {c.notes}
                    </li>
                  )),
              )}
            </ul>
          </div>
          )}
        </>
      )}
    </div>
  )
}
