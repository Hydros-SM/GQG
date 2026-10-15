import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { FilePen, Undo2, AlertOctagon, AlertTriangle, CheckCircle2, Plus, X, RotateCcw } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../context/AuthContext'
import { useIsMobile, useMediaQuery } from '../../hooks/useMediaQuery'
import CorrectionWellDiagram from '../../components/report/CorrectionWellDiagram'
import SearchSelect from '../../components/SearchSelect'
import Modal from '../../components/Modal'
import { MASTER_COLORS } from '../../components/report/ReportCharts'
import { DRILL_DIAMETERS, paintIntervals, type DiamInterval } from '../../lib/drillDiameters'
import { round2 } from '../../lib/taskProgress'
import { formatRu } from '../../lib/workerStay'
import type { CostCategory, CostItem, DrillingTask, Position, Profile, Report, Site } from '../../types/database'
import { isMasterProfile } from '../../lib/masters'
import { shortName } from '../../lib/shortName'

interface DiamRow {
  from: string
  to: string
  code: string
  reaming: boolean
}
interface CasRow {
  code: string
  depth: string
}
interface CostRow {
  item: string
  qty: string
}
interface Fields {
  meters: string
  hours: string
  authorId: string
  notes: string
  date: string
  shift: string
  diameters: DiamRow[]
  casings: CasRow[]
  costs: CostRow[]
}
interface Validation {
  ok: boolean
  errors: string[]
  warnings: string[]
  old_depth: number
  new_depth: number
  shifted: number
}
interface LogRow {
  id: string
  batch_id: string
  report_id: string
  editor_id: string | null
  edited_at: string
  reason: string
  changes: Record<string, { old: unknown; new: unknown }>
  reverted: boolean
}

const FIELD_LABELS: Record<string, string> = {
  drilling_meters: 'Метры',
  hours_worked: 'Часы',
  author_id: 'Мастер',
  shift_notes: 'Комментарий',
  report_date: 'Дата',
  shift_number: 'Смена',
  diameters: 'Диаметры',
  casings: 'Обсадка',
  costs: 'Затраты',
}
const TYPE_FILTERS: [string, string][] = [
  ['all', 'Все'],
  ['drilling_meters', 'Метры'],
  ['author_id', 'Мастер'],
  ['hours_worked', 'Часы'],
  ['diameters', 'Диаметры'],
  ['casings', 'Обсадка'],
  ['costs', 'Затраты'],
]
const DIAM_COLOR: Record<string, string> = { AQ: '#8a5a9e', BQ: '#b09a2e', NQ: '#3c7a52', HQ: '#0b3a5a', PQ: '#6f96b8' }

const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const dm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`
const labelOf = (f: Fields) => (f.shift ? `${dm(f.date)}, смена ${f.shift}` : '')

// Исправление согласованных сводок (08.10.2026). Компактная таблица по дням,
// боковой редактор смены, мини-схема скважины с подсветкой изменений,
// подтверждение «что изменится» и журнал лентой по дням с фильтрами.
export default function ReportCorrections() {
  const { session, profile, can, loading: authLoading } = useAuth()
  const isMobile = useIsMobile()
  // На узком экране карточка смены открывается шторкой, а не колонкой справа
  const narrow = useMediaQuery('(max-width: 1279px)')
  const [sites, setSites] = useState<Site[]>([])
  const [tasks, setTasks] = useState<DrillingTask[]>([])
  const [siteId, setSiteId] = useState('')
  const [taskId, setTaskId] = useState('')
  const [reports, setReports] = useState<Report[]>([])
  const [orig, setOrig] = useState<Record<string, Fields>>({})
  const [masters, setMasters] = useState<Profile[]>([])
  const [costItems, setCostItems] = useState<CostItem[]>([])
  const [costCats, setCostCats] = useState<CostCategory[]>([])
  const [edits, setEdits] = useState<Record<string, Partial<Fields>>>({})
  const [panelId, setPanelId] = useState<string | null>(null)
  const [tab, setTab] = useState<'edit' | 'log'>('edit')
  const [rowFilter, setRowFilter] = useState<'all' | 'changed' | 'errors'>('all')
  const [logs, setLogs] = useState<LogRow[]>([])
  const [logType, setLogType] = useState('all')
  const [logMaster, setLogMaster] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [reason, setReason] = useState('')
  const [ack, setAck] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [val, setVal] = useState<Validation | null>(null)
  const [allErrors, setAllErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Добавление пропущенной даты (15.10.2026): новые сводки живут в таблице как черновые
  // строки и создаются вместе с остальными правками при «Применить».
  const [newIds, setNewIds] = useState<Set<string>>(new Set())
  const [addOpen, setAddOpen] = useState(false)
  const [addDate, setAddDate] = useState('')
  const [addShifts, setAddShifts] = useState<Record<1 | 2, boolean>>({ 1: true, 2: true })
  const [addError, setAddError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    Promise.all([
      supabase.from('sites').select('*').order('name'),
      supabase.from('drilling_tasks').select('*').order('well_number'),
      supabase.from('profiles').select('*').eq('role', 'party_chief').order('full_name'),
      supabase.from('cost_items').select('*').order('name'),
      supabase.from('cost_categories').select('*').order('name'),
      supabase.from('positions').select('*'),
    ]).then(([s, t, p, ci, cc, pos]) => {
      setCostItems((ci.data ?? []) as CostItem[])
      setCostCats((cc.data ?? []) as CostCategory[])
      setSites((s.data ?? []) as Site[])
      setTasks((t.data ?? []) as DrillingTask[])
      setMasters(((p.data ?? []) as Profile[]).filter((x) => isMasterProfile(x, (pos.data ?? []) as Position[])))
    })
  }, [session])

  const loadWell = useCallback(async () => {
    if (!taskId) {
      setReports([])
      setOrig({})
      setLogs([])
      return
    }
    setLoading(true)
    const { data: reps } = await supabase
      .from('reports')
      .select('*')
      .eq('drilling_task_id', taskId)
      .in('approval_status', ['approved', 'submitted'])
      .order('report_date')
      .order('shift_number')
    const list = (reps ?? []) as Report[]
    const ids = list.map((r) => r.id)
    const [dRes, cRes, kRes, lRes] = await Promise.all([
      ids.length ? supabase.from('report_drill_diameters').select('*').in('report_id', ids) : Promise.resolve({ data: [] }),
      ids.length ? supabase.from('report_casings').select('*').in('report_id', ids) : Promise.resolve({ data: [] }),
      ids.length ? supabase.from('report_costs').select('*').in('report_id', ids) : Promise.resolve({ data: [] }),
      supabase.from('report_edit_log').select('*').eq('task_id', taskId).order('edited_at', { ascending: false }).limit(200),
    ])
    const o: Record<string, Fields> = {}
    for (const r of list) {
      o[r.id] = {
        meters: r.drilling_meters != null ? String(round2(r.drilling_meters)) : '0',
        hours: r.hours_worked != null ? String(r.hours_worked) : '',
        authorId: r.author_id,
        notes: r.shift_notes ?? '',
        date: r.report_date,
        shift: r.shift_number ? String(r.shift_number) : '',
        diameters: ((dRes.data ?? []) as { report_id: string; depth_from: number; depth_to: number; diameter_code: string; is_reaming: boolean }[])
          .filter((d) => d.report_id === r.id)
          .sort((a, b) => Number(a.is_reaming) - Number(b.is_reaming) || a.depth_from - b.depth_from)
          .map((d) => ({ from: String(round2(d.depth_from)), to: String(round2(d.depth_to)), code: d.diameter_code, reaming: d.is_reaming })),
        casings: ((cRes.data ?? []) as { report_id: string; diameter_code: string; depth_to: number }[])
          .filter((c) => c.report_id === r.id)
          .map((c) => ({ code: c.diameter_code, depth: String(round2(c.depth_to)) })),
        costs: ((kRes.data ?? []) as { report_id: string; cost_item_id: string; quantity: number | null }[])
          .filter((k) => k.report_id === r.id)
          .map((k) => ({ item: k.cost_item_id, qty: k.quantity != null ? String(k.quantity) : '' })),
      }
    }
    setReports(list)
    setOrig(o)
    setNewIds(new Set())
    setEdits({})
    setVal(null)
    setAck(false)
    setPanelId(null)
    const logRows = (lRes.data ?? []) as LogRow[]
    setLogs(logRows)
    const pids: string[] = [...list.map((r) => r.author_id), ...logRows.map((l) => l.editor_id).filter((x): x is string => !!x)]
    for (const l of logRows) {
      const a = l.changes.author_id
      if (a) pids.push(String(a.old), String(a.new))
    }
    if (pids.length) {
      const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', [...new Set(pids)])
      setNames(Object.fromEntries((profs ?? []).map((p) => [p.id as string, shortName(p.full_name as string)])))
    }
    setLoading(false)
  }, [taskId])

  useEffect(() => {
    loadWell()
  }, [loadWell])

  const eff = useCallback((id: string): Fields => ({ ...orig[id], ...edits[id] }) as Fields, [orig, edits])
  const setField = <K extends keyof Fields>(id: string, key: K, value: Fields[K]) => {
    setMsg(null)
    setAck(false)
    setEdits((prev) => {
      const cur = { ...(prev[id] ?? {}) } as Partial<Fields>
      if (same(orig[id][key], value)) delete cur[key]
      else cur[key] = value
      const next = { ...prev }
      if (Object.keys(cur).length === 0) delete next[id]
      else next[id] = cur
      return next
    })
  }
  const dropDrafts = (ids: Set<string>) => {
    if (ids.size === 0) return
    setReports((prev) => prev.filter((r) => !ids.has(r.id)))
    setOrig((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !ids.has(k))))
    setNewIds((prev) => new Set([...prev].filter((x) => !ids.has(x))))
    if (panelId && ids.has(panelId)) setPanelId(null)
  }
  const resetReport = (id: string) => {
    if (newIds.has(id)) dropDrafts(new Set([id]))
    setEdits((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }
  const discardAll = () => {
    dropDrafts(new Set(newIds))
    setEdits({})
    setVal(null)
    setAck(false)
  }
  const nextDay = (iso: string) => {
    const d = new Date(iso + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  }
  function openAdd(defaultDate: string) {
    setAddDate(defaultDate)
    setAddShifts({ 1: true, 2: true })
    setAddError(null)
    setAddOpen(true)
  }
  function addDay() {
    if (!profile || !taskId) return
    if (!addDate) return setAddError('Укажите дату')
    if (addDate > new Date().toISOString().slice(0, 10)) return setAddError('Нельзя добавить сводку на будущую дату')
    const shifts = ([1, 2] as const).filter((x) => addShifts[x])
    if (shifts.length === 0) return setAddError('Выберите хотя бы одну смену')
    const taken = shifts.filter((x) => reports.some((r) => { const e = eff(r.id); return e.date === addDate && e.shift === String(x) }))
    if (taken.length > 0) return setAddError('На эту дату уже есть сводка за смену ' + taken.join(', '))
    const siteOfTask = tasks.find((t) => t.id === taskId)?.site_id ?? ''
    const created: Report[] = []
    const blank: Record<string, Fields> = {}
    const ed: Record<string, Partial<Fields>> = {}
    for (const x of shifts) {
      const id = crypto.randomUUID()
      created.push({ id, drilling_task_id: taskId, site_id: siteOfTask, author_id: profile.id, report_date: addDate, shift_number: x, approval_status: 'approved', edit_count: 0 } as unknown as Report)
      blank[id] = { meters: '0', hours: '', authorId: profile.id, notes: '', date: '', shift: '', diameters: [], casings: [], costs: [] }
      ed[id] = { date: addDate, shift: String(x) }
    }
    setNames((prev) => ({ ...prev, [profile.id]: shortName(profile.full_name) }))
    setReports((prev) => [...prev, ...created])
    setOrig((prev) => ({ ...prev, ...blank }))
    setEdits((prev) => ({ ...prev, ...ed }))
    setNewIds((prev) => new Set([...prev, ...created.map((c) => c.id)]))
    setMsg(null)
    setAck(false)
    setAddOpen(false)
    setPanelId(created[0].id)
  }

  const ordered = useMemo(
    () =>
      [...reports].sort((a, b) => {
        const fa = { ...orig[a.id], ...edits[a.id] } as Fields
        const fb = { ...orig[b.id], ...edits[b.id] } as Fields
        return fa.date.localeCompare(fb.date) || Number(fa.shift || 0) - Number(fb.shift || 0)
      }),
    [reports, orig, edits],
  )
  const bottomAfter = useMemo(() => {
    let run = 0
    const out: Record<string, { s: number; e: number }> = {}
    for (const r of ordered) {
      const f = { ...orig[r.id], ...edits[r.id] } as Fields
      const m = Number(f.meters) || 0
      out[r.id] = { s: round2(run), e: round2(run + m) }
      run += m
    }
    return out
  }, [ordered, orig, edits])
  const bottomOrig = useMemo(() => {
    let run = 0
    const out: Record<string, number> = {}
    for (const r of [...reports].sort((a, b) => orig[a.id].date.localeCompare(orig[b.id].date) || Number(orig[a.id].shift || 0) - Number(orig[b.id].shift || 0))) {
      run += Number(orig[r.id].meters) || 0
      out[r.id] = round2(run)
    }
    return out
  }, [reports, orig])

  const payload = useMemo(
    () =>
      Object.entries(edits).map(([id, e]) => {
        if (newIds.has(id)) {
          const nf = { ...orig[id], ...e } as Fields
          return {
            report_id: id,
            new: true,
            date: nf.date,
            shift: nf.shift === '' ? null : Number(nf.shift),
            author_id: nf.authorId,
            meters: Number(nf.meters) || 0,
            hours: numOrNull(nf.hours),
            notes: nf.notes,
            diameters: nf.diameters.filter((d) => d.code).map((d) => ({ from: Number(d.from), to: Number(d.to), code: d.code, reaming: d.reaming })),
            casings: nf.casings.filter((c) => c.code).map((c) => ({ code: c.code, depth: Number(c.depth) })),
            costs: nf.costs.filter((c) => c.item).map((c) => ({ item: c.item, qty: Number(c.qty) })),
          } as Record<string, unknown>
        }
        const p: Record<string, unknown> = { report_id: id }
        if (e.meters !== undefined) p.meters = Number(e.meters) || 0
        if (e.hours !== undefined) p.hours = numOrNull(e.hours)
        if (e.authorId !== undefined) p.author_id = e.authorId
        if (e.notes !== undefined) p.notes = e.notes
        if (e.date !== undefined) p.date = e.date
        if (e.shift !== undefined) p.shift = e.shift === '' ? null : Number(e.shift)
        if (e.diameters !== undefined) p.diameters = e.diameters.filter((d) => d.code).map((d) => ({ from: Number(d.from), to: Number(d.to), code: d.code, reaming: d.reaming }))
        if (e.costs !== undefined) p.costs = e.costs.filter((c) => c.item).map((c) => ({ item: c.item, qty: Number(c.qty) }))
        if (e.casings !== undefined) p.casings = e.casings.filter((c) => c.code).map((c) => ({ code: c.code, depth: Number(c.depth) }))
        return p
      }),
    [edits, newIds, orig],
  )

  useEffect(() => {
    if (!taskId || payload.length === 0) {
      setVal(null)
      return
    }
    const t = window.setTimeout(async () => {
      const { data, error: rpcError } = await supabase.rpc('admin_edit_reports', { p_task: taskId, p_reason: reason, p_edits: payload, p_apply: false })
      if (rpcError) {
        setError(rpcError.message)
        return
      }
      setError(null)
      setVal(data as Validation)
    }, 450)
    return () => window.clearTimeout(t)
  }, [payload, taskId, reason])

  // ошибки сервера → по строкам таблицы (по метке «ДД.ММ, смена N»)
  const rowErrors = useMemo(() => {
    const map: Record<string, string[]> = {}
    const rest: string[] = []
    for (const err of val?.errors ?? []) {
      const owner = reports.find((r) => {
        const l = labelOf(eff(r.id))
        return l !== '' && err.includes(l)
      })
      if (owner) (map[owner.id] ??= []).push(err)
      else rest.push(err)
    }
    return { map, rest }
  }, [val, reports, eff])

  async function apply() {
    setBusy(true)
    setError(null)
    const { data, error: rpcError } = await supabase.rpc('admin_edit_reports', { p_task: taskId, p_reason: reason.trim(), p_edits: payload, p_apply: true })
    setBusy(false)
    if (rpcError) {
      setError(rpcError.message)
      return
    }
    const res = data as Validation & { applied: boolean }
    if (!res.applied) {
      setVal(res)
      setConfirmOpen(false)
      return
    }
    setConfirmOpen(false)
    setReason('')
    setMsg(`Изменения применены (сводок: ${payload.length}${newIds.size > 0 ? `, добавлено: ${newIds.size}` : ''}). Забой: ${res.old_depth} → ${res.new_depth} м.`)
    await loadWell()
  }

  async function revert(id: string) {
    setBusy(true)
    setError(null)
    const { data, error: rpcError } = await supabase.rpc('admin_revert_edit', { p_log: id, p_reason: null })
    setBusy(false)
    if (rpcError) {
      setError(rpcError.message)
      return
    }
    const res = data as Validation & { applied: boolean }
    if (!res.applied) {
      setError('Откат невозможен: ' + res.errors.join('; '))
      return
    }
    setMsg('Исправление откатено.')
    await loadWell()
  }

  function fitIntervals() {
    for (const r of ordered) {
      const f = eff(r.id)
      const pos = bottomAfter[r.id]
      const normal = f.diameters.filter((d) => !d.reaming)
      if (normal.length === 0 || (Number(f.meters) || 0) <= 0) continue
      const reaming = f.diameters.filter((d) => d.reaming)
      const moved: DiamRow[] = []
      let prevTo = pos.s
      normal.forEach((d, i) => {
        const len = Number(d.to) - Number(d.from)
        const from = i === 0 ? pos.s : prevTo
        const to = i === normal.length - 1 ? pos.e : round2(from + len)
        prevTo = to
        moved.push({ ...d, from: String(round2(from)), to: String(round2(to)) })
      })
      const next = [...moved, ...reaming]
      setField(r.id, 'diameters', same(next, orig[r.id].diameters) ? orig[r.id].diameters : next)
    }
  }

  function focusCell(col: string, index: number) {
    document.querySelector<HTMLElement>(`[data-cell="${col}-${index}"]`)?.focus()
  }

  if (authLoading) return <p>Загрузка…</p>
  if (!session) return <Navigate to="/login" replace />
  if (!can('corrections_db')) return <p>Исправлять сводки может только руководство.</p>

  const panelReport = reports.find((r) => r.id === panelId) ?? null
  const siteOptions = sites.map((s) => ({ value: s.id, label: s.name }))
  const taskOptions = tasks
    .filter((t) => !siteId || t.site_id === siteId)
    .map((t) => ({ value: t.id, label: `№${t.well_number}`, hint: siteId ? undefined : sites.find((s) => s.id === t.site_id)?.name }))
  const editedCount = Object.keys(edits).length
  const hasErrors = !!val && val.errors.length > 0
  const needAck = !!val && val.warnings.length > 0
  const canOpenConfirm = editedCount > 0 && !!val && !hasErrors
  const canApply = canOpenConfirm && reason.trim().length >= 3 && (!needAck || ack) && !busy
  const colorOf = (id: string) => MASTER_COLORS[Math.max(0, masters.findIndex((m) => m.id === id)) % MASTER_COLORS.length]
  const nameOf = (id: string) => names[id] ?? (shortName(masters.find((m) => m.id === id)?.full_name) || '—')
  const itemName = (id: string) => {
    const it = costItems.find((x) => x.id === id)
    return it ? `${costCats.find((c) => c.id === it.category_id)?.name ?? ''} — ${it.name}` : '—'
  }

  // группировка по дням с учётом фильтра
  const visible = ordered.filter((r) => rowFilter === 'all' || (rowFilter === 'changed' ? !!edits[r.id] : !!rowErrors.map[r.id]))
  const days: { date: string; rows: Report[] }[] = []
  for (const r of visible) {
    const d = eff(r.id).date
    const last = days[days.length - 1]
    if (last && last.date === d) last.rows.push(r)
    else days.push({ date: d, rows: [r] })
  }
  const rowIndex = new Map(visible.map((r, i) => [r.id, i]))

  const ribbonIntervals: DiamInterval[] = paintIntervals(
    ordered.flatMap((r) =>
      [...eff(r.id).diameters]
        .filter((d) => d.code)
        .sort((a, b) => Number(a.reaming) - Number(b.reaming))
        .map((d) => ({ code: d.code, from: Number(d.from), to: Number(d.to) })),
    ),
  )
  const origEnd = Math.max(0, ...Object.values(bottomOrig))
  const effCasings = (() => {
    const m = new Map<string, number>()
    for (const r of reports) for (const c of eff(r.id).casings) if (c.code) m.set(c.code, Math.max(m.get(c.code) ?? 0, Number(c.depth) || 0))
    return [...m.entries()].map(([code, depth]) => ({ code, depth }))
  })()
  const diagramSegments = ordered.map((r) => {
    const f = eff(r.id)
    return {
      id: r.id,
      s: bottomAfter[r.id].s,
      e: bottomAfter[r.id].e,
      color: colorOf(f.authorId),
      changed: !!edits[r.id],
      error: !!rowErrors.map[r.id],
      label: `${formatRu(f.date).slice(0, 5)}, смена ${f.shift || '—'}: ${f.meters} м (${nameOf(f.authorId)})`,
    }
  })
  const projectedDepth = tasks.find((t) => t.id === taskId)?.projected_depth ?? null
  const showPanelColumn = !!panelReport && !narrow
  const newEnd = Math.max(0, ...Object.values(bottomAfter).map((p) => p.e))

  const renderPanel = (r: Report) => {
    const f = eff(r.id)
    const ed = edits[r.id] ?? {}
    const pos = bottomAfter[r.id]
    const ch = (k: keyof Fields) => (k in ed ? ' is-changed' : '')
    const errs = rowErrors.map[r.id] ?? []
    const rowDiam: DiamInterval[] = f.diameters.filter((d) => d.code && !d.reaming).map((d) => ({ code: d.code, from: Number(d.from), to: Number(d.to) }))
    const base = Math.min(pos.s, ...rowDiam.map((d) => d.from))
    const span = Math.max(1, Math.max(pos.e, ...rowDiam.map((d) => d.to)) - base)
    return (
      <div className="corr-panel-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <b>{formatRu(f.date).slice(0, 5)}{f.shift ? ` · смена ${f.shift}` : ''}</b>
          <span style={{ display: 'flex', gap: 6 }}>
            {edits[r.id] && (
              <button type="button" className="btn-outline" onClick={() => resetReport(r.id)} style={{ fontSize: 12, padding: '3px 10px', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <RotateCcw size={12} /> Сбросить
              </button>
            )}
            <button type="button" className="corr-more" onClick={() => setPanelId(null)} aria-label="Закрыть"><X size={16} /></button>
          </span>
        </div>
        {errs.map((x, i) => (
          <div key={i} className="corr-msg"><AlertOctagon size={14} style={{ color: 'var(--color-danger)' }} /><span>{x}</span></div>
        ))}
        <div className="corr-grid2">
          <label>Мастер
            <select className={'corr-in' + ch('authorId')} value={f.authorId} onChange={(e) => setField(r.id, 'authorId', e.target.value)}>
              {masters.some((m) => m.id === f.authorId) ? null : <option value={f.authorId}>{nameOf(f.authorId)}</option>}
              {masters.map((m) => <option key={m.id} value={m.id}>{shortName(m.full_name)}</option>)}
            </select>
          </label>
          <label>Метры
            <input type="number" step="any" className={'corr-in' + ch('meters') + ((Number(f.meters) || 0) < 0 ? ' is-error' : '')} value={f.meters} onChange={(e) => setField(r.id, 'meters', e.target.value)} />
          </label>
          <label>Часы
            <input type="number" step="any" className={'corr-in' + ch('hours')} value={f.hours} onChange={(e) => setField(r.id, 'hours', e.target.value)} />
          </label>
          <label>Дата
            <input type="date" className={'corr-in' + ch('date')} value={f.date} onChange={(e) => setField(r.id, 'date', e.target.value)} />
          </label>
          <label>Смена
            <select className={'corr-in' + ch('shift')} value={f.shift} onChange={(e) => setField(r.id, 'shift', e.target.value)}>
              <option value="">—</option><option value="1">1</option><option value="2">2</option>
            </select>
          </label>
        </div>
        <label>Комментарий смены
          <textarea rows={2} className={'corr-in' + ch('notes')} value={f.notes} onChange={(e) => setField(r.id, 'notes', e.target.value)} />
        </label>

        <div>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Интервалы диаметров · нужно {pos.s}–{pos.e} м</div>
          <svg viewBox="0 0 300 26" style={{ width: '100%', display: 'block', marginBottom: 6 }} role="img">
            <title>Интервалы диаметров смены</title>
            <rect x={0} y={4} width={300} height={16} fill="var(--color-surface-muted)" />
            {rowDiam.map((d, i) => (
              <rect key={i} x={((d.from - base) / span) * 300} y={4} width={Math.max(1, ((d.to - d.from) / span) * 300)} height={16} fill={DIAM_COLOR[d.code] ?? '#7d868c'} />
            ))}
            <line x1={((pos.s - base) / span) * 300} x2={((pos.s - base) / span) * 300} y1={0} y2={26} stroke="var(--color-accent)" strokeWidth={2} />
            <line x1={((pos.e - base) / span) * 300} x2={((pos.e - base) / span) * 300} y1={0} y2={26} stroke="var(--color-accent)" strokeWidth={2} />
          </svg>
          {f.diameters.map((d, i) => (
            <div key={i} className="corr-drow">
              <input type="number" step="any" className="corr-in" value={d.from} onChange={(e) => setField(r.id, 'diameters', f.diameters.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} aria-label="От" />
              <input type="number" step="any" className="corr-in" value={d.to} onChange={(e) => setField(r.id, 'diameters', f.diameters.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} aria-label="До" />
              <select className="corr-in" value={d.code} onChange={(e) => setField(r.id, 'diameters', f.diameters.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))}>
                {DRILL_DIAMETERS.map((x) => <option key={x.code} value={x.code}>{x.code}</option>)}
              </select>
              <label style={{ margin: 0, display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={d.reaming} onChange={(e) => setField(r.id, 'diameters', f.diameters.map((x, j) => (j === i ? { ...x, reaming: e.target.checked } : x)))} /> расш.
              </label>
              <button type="button" className="corr-more" onClick={() => setField(r.id, 'diameters', f.diameters.filter((_, j) => j !== i))} aria-label="Убрать интервал"><X size={14} /></button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn-outline" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => setField(r.id, 'diameters', [...f.diameters, { from: String(pos.s), to: String(pos.e), code: f.diameters[0]?.code ?? 'HQ', reaming: false }])}>
              <Plus size={12} /> интервал
            </button>
            <button type="button" className="btn-outline" style={{ fontSize: 12, padding: '3px 10px' }} onClick={fitIntervals}>Подогнать под забой</button>
          </div>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Обсадка, внесённая в этой сводке (в том числе дообсадка)</div>
          {f.casings.map((c, i) => (
            <div key={i} className="corr-crow2">
              <select className="corr-in" value={c.code} onChange={(e) => setField(r.id, 'casings', f.casings.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))}>
                {DRILL_DIAMETERS.map((x) => <option key={x.code} value={x.code}>{x.code}</option>)}
              </select>
              <input type="number" step="any" className="corr-in" value={c.depth} onChange={(e) => setField(r.id, 'casings', f.casings.map((x, j) => (j === i ? { ...x, depth: e.target.value } : x)))} aria-label="Глубина обсадки" />
              <button type="button" className="corr-more" onClick={() => setField(r.id, 'casings', f.casings.filter((_, j) => j !== i))} aria-label="Убрать обсадку"><X size={14} /></button>
            </div>
          ))}
          <button type="button" className="btn-outline" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => setField(r.id, 'casings', [...f.casings, { code: 'PQ', depth: String(pos.e) }])}>
            <Plus size={12} /> обсадка
          </button>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Статьи затрат</div>
          {f.costs.map((k, i) => (
            <div key={i} className="corr-crow">
              <select className="corr-in" value={k.item} onChange={(e) => setField(r.id, 'costs', f.costs.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)))}>
                <option value="">— статья —</option>
                {costItems.map((it) => (
                  <option key={it.id} value={it.id}>{itemName(it.id) + (it.unit ? ` (${it.unit})` : '')}</option>
                ))}
              </select>
              <input type="number" step="any" className="corr-in" value={k.qty} onChange={(e) => setField(r.id, 'costs', f.costs.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label="Количество" />
              <button type="button" className="corr-more" onClick={() => setField(r.id, 'costs', f.costs.filter((_, j) => j !== i))} aria-label="Убрать статью"><X size={14} /></button>
            </div>
          ))}
          <button type="button" className="btn-outline" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => setField(r.id, 'costs', [...f.costs, { item: '', qty: '' }])}>
            <Plus size={12} /> статья затрат
          </button>
        </div>
      </div>
    )
  }

  // журнал: лента по дням с фильтрами
  const logsFiltered = logs.filter((l) => {
    if (logType !== 'all' && !(logType in l.changes)) return false
    if (logMaster) {
      const rep = reports.find((r) => r.id === l.report_id)
      if (!rep || rep.author_id !== logMaster) return false
    }
    return true
  })
  const logDays: { day: string; rows: LogRow[] }[] = []
  for (const l of logsFiltered) {
    const day = l.edited_at.slice(0, 10)
    const last = logDays[logDays.length - 1]
    if (last && last.day === day) last.rows.push(l)
    else logDays.push({ day, rows: [l] })
  }
  const showVal = (k: string, v: unknown) => (k === 'author_id' ? nameOf(String(v)) : v == null ? '—' : String(v))

  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '0 0 6px' }}>
        <FilePen size={22} className="text-muted" /> БД сводок
      </h1>
      <p className="text-muted" style={{ fontSize: 12, marginTop: 0 }}>
        Только руководство. Любое изменение проверяется, фиксируется в журнале с причиной и пересчитывает забой следующих смен.
      </p>

      <div className="card" style={{ padding: 14, marginBottom: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <label style={{ marginBottom: 0 }}>
          Участок
          <SearchSelect options={siteOptions} value={siteId} onChange={(v) => { setSiteId(v); setTaskId('') }} emptyLabel="Все участки" ariaLabel="Участок" />
        </label>
        <label style={{ marginBottom: 0 }}>
          Скважина
          <SearchSelect
            options={taskOptions}
            value={taskId}
            onChange={(v) => {
              setTaskId(v)
              if (v && !siteId) setSiteId(tasks.find((t) => t.id === v)?.site_id ?? '')
            }}
            emptyLabel="Выберите скважину"
            placeholder="Введите номер…"
            ariaLabel="Скважина"
          />
        </label>
      </div>

      {!taskId ? (
        <p className="text-muted">Выберите скважину, чтобы увидеть её согласованные сводки.</p>
      ) : (
        <>
          <div className="org-views" role="tablist">
            <button type="button" className={tab === 'edit' ? 'is-on' : ''} onClick={() => setTab('edit')}>Исправление</button>
            <button type="button" className={tab === 'log' ? 'is-on' : ''} onClick={() => setTab('log')}>Журнал · {logs.length}</button>
          </div>

          {msg && <p className="text-success" style={{ margin: '0 0 10px' }}>{msg}</p>}
          {error && tab === 'log' && <p className="text-error" style={{ margin: '0 0 10px' }}>{error}</p>}

          {loading ? (
            <div className="skeleton" style={{ height: 200, borderRadius: 'var(--radius-md)' }} />
          ) : tab === 'log' ? (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
                {TYPE_FILTERS.map(([k, label]) => (
                  <button key={k} type="button" className={logType === k ? undefined : 'btn-outline'} onClick={() => setLogType(k)} style={{ minHeight: 30, padding: '2px 10px', fontSize: 12 }}>{label}</button>
                ))}
                <select value={logMaster} onChange={(e) => setLogMaster(e.target.value)} style={{ maxWidth: 220, minHeight: 32, fontSize: 13 }} aria-label="Мастер">
                  <option value="">Все мастера</option>
                  {masters.map((m) => <option key={m.id} value={m.id}>{shortName(m.full_name)}</option>)}
                </select>
              </div>
              {logDays.length === 0 ? (
                <p className="text-muted" style={{ margin: 0 }}>Исправлений по этому фильтру нет.</p>
              ) : (
                logDays.map((g) => (
                  <div key={g.day} style={{ marginBottom: 14 }}>
                    <div className="eyebrow" style={{ marginBottom: 4 }}>{formatRu(g.day)}</div>
                    <div className="corr-feed">
                      {g.rows.map((l) => {
                        const rep = reports.find((r) => r.id === l.report_id)
                        return (
                          <div key={l.id} className="corr-log">
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                              <b>
                                {rep ? `${formatRu(rep.report_date).slice(0, 5)}${rep.shift_number ? ` · смена ${rep.shift_number}` : ''}` : 'сводка'}
                                {rep ? <span className="text-muted" style={{ fontWeight: 400 }}> · {shortName(nameOf(rep.author_id))}</span> : null}
                              </b>
                              <span className="text-muted" style={{ fontSize: 12 }}>
                                {new Date(l.edited_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · {nameOf(l.editor_id ?? '')}
                              </span>
                            </div>
                            <div style={{ fontSize: 13 }}>
                              {Object.entries(l.changes).map(([k, v]) => (
                                <div key={k}>
                                  {k !== 'created' && <span className="text-muted">{FIELD_LABELS[k] ?? k}: </span>}
                                  {k === 'created' ? 'сводка добавлена администратором' : k === 'diameters' || k === 'casings' || k === 'costs' ? 'изменены' : `${showVal(k, v.old)} → ${showVal(k, v.new)}`}
                                </div>
                              ))}
                            </div>
                            <div className="text-muted" style={{ fontSize: 12 }}>Причина: {l.reason}</div>
                            {l.reverted ? (
                              <span className="badge badge-neutral" style={{ marginTop: 4, justifySelf: 'start' }}>откатено</span>
                            ) : 'created' in l.changes ? null : (
                              <button type="button" className="btn-outline" disabled={busy} onClick={() => revert(l.id)} style={{ marginTop: 4, fontSize: 12, padding: '3px 10px', display: 'inline-flex', gap: 5, alignItems: 'center', justifySelf: 'start' }}>
                                <Undo2 size={13} /> Откатить
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {([['all', 'Все · ' + reports.length], ['changed', 'Только изменённые · ' + editedCount], ['errors', 'С ошибками · ' + Object.keys(rowErrors.map).length]] as const).map(([k, label]) => (
                  <button key={k} type="button" className={rowFilter === k ? undefined : 'btn-outline'} onClick={() => setRowFilter(k)} style={{ minHeight: 32, padding: '3px 12px', fontSize: 13 }}>{label}</button>
                ))}
              </div>

              <div className={`corr-split3${showPanelColumn ? ' has-panel' : ''}${isMobile ? ' is-mobile' : ''}`}>
                <div className="corr-scroll">
                  <table className="corr-table corr-compact">
                    <thead>
                      <tr><th style={{ width: 56 }}>Смена</th><th>Мастер</th><th style={{ width: 90 }}>Метры</th><th style={{ width: 70 }}>Часы</th><th style={{ width: 120 }}>Забой после</th><th>Метки</th></tr>
                    </thead>
                    <tbody>
                      {days.map((g, gi) => (
                        <Fragment key={g.date}>
                          {rowFilter === 'all' && (
                            <tr className="corr-add">
                              <td colSpan={6} style={{ padding: '2px 8px' }}>
                                <button type="button" className="corr-link" onClick={() => openAdd(gi === 0 ? g.date : nextDay(days[gi - 1].date))}>
                                  <Plus size={11} /> добавить дату
                                </button>
                              </td>
                            </tr>
                          )}
                          <tr className="corr-day">
                            <td colSpan={6}>
                              {formatRu(g.date).slice(0, 5)} · {round2(g.rows.reduce((s, r) => s + (Number(eff(r.id).meters) || 0), 0))} м
                              {g.rows.some((r) => edits[r.id]) && <span className="badge badge-warning" style={{ marginLeft: 8 }}>изменено</span>}
                            </td>
                          </tr>
                          {g.rows.map((r) => {
                            const f = eff(r.id)
                            const ed = edits[r.id] ?? {}
                            const pos = bottomAfter[r.id]
                            const was = bottomOrig[r.id]
                            const idx = rowIndex.get(r.id) ?? 0
                            const ch = (k: keyof Fields) => (k in ed ? ' is-changed' : '')
                            const errs = rowErrors.map[r.id] ?? []
                            const negative = (Number(f.meters) || 0) < 0
                            return (
                              <tr key={r.id} className={`corr-row${panelId === r.id ? ' is-open' : ''}`} onClick={() => setPanelId(r.id)}>
                                <td>{f.shift || '—'}</td>
                                <td onClick={(e) => e.stopPropagation()}>
                                  <select className={'corr-cell' + ch('authorId')} value={f.authorId} onChange={(e) => setField(r.id, 'authorId', e.target.value)}>
                                    {masters.some((m) => m.id === f.authorId) ? null : <option value={f.authorId}>{nameOf(f.authorId)}</option>}
                                    {masters.map((m) => <option key={m.id} value={m.id}>{shortName(m.full_name)}</option>)}
                                  </select>
                                  {'authorId' in ed && <span className="corr-was"> ← {shortName(nameOf(orig[r.id].authorId))}</span>}
                                </td>
                                <td onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="number"
                                    step="any"
                                    data-cell={`m-${idx}`}
                                    className={'corr-cell' + ch('meters') + (negative ? ' is-error' : '')}
                                    value={f.meters}
                                    onChange={(e) => setField(r.id, 'meters', e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && focusCell('m', idx + 1)}
                                  />
                                  {'meters' in ed && <span className="corr-was">← {orig[r.id].meters}</span>}
                                </td>
                                <td onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="number"
                                    step="any"
                                    data-cell={`h-${idx}`}
                                    className={'corr-cell' + ch('hours')}
                                    value={f.hours}
                                    onChange={(e) => setField(r.id, 'hours', e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && focusCell('h', idx + 1)}
                                  />
                                </td>
                                <td className="num">
                                  <b>{pos.e}</b>
                                  {Math.abs(pos.e - was) > 0.005 && <span className="corr-was"> было {was}</span>}
                                </td>
                                <td>
                                  <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                                    {errs.length > 0 && (
                                      <span className="badge badge-danger" title={errs.join('\n')}>
                                        {errs[0].startsWith('Отрицательный') ? 'отрицательный метраж' : errs[0].startsWith('Интервалы') ? 'диаметры не сходятся' : 'ошибка'}
                                      </span>
                                    )}
                                    {newIds.has(r.id) && <span className="badge badge-primary" title="Новая сводка: создаётся при «Применить»">новая</span>}
                                    {!newIds.has(r.id) && (r.edit_count ?? 0) > 0 && <span className="badge badge-neutral" title="Эта сводка уже исправлялась">испр.</span>}
                                    {f.diameters.some((d) => d.reaming) && <span className="text-muted" style={{ fontSize: 11 }}>расш.</span>}
                                    {f.casings.length > 0 && <span className="text-muted" style={{ fontSize: 11 }}>обс. {f.casings.map((c) => c.code).join(',')}</span>}
                                    {f.costs.length > 0 && <span className="text-muted" style={{ fontSize: 11 }}>затр. {f.costs.length}</span>}
                                    {edits[r.id] && (
                                      <button type="button" className="corr-more" onClick={(e) => { e.stopPropagation(); resetReport(r.id) }} aria-label="Сбросить изменения сводки" title="Сбросить изменения сводки"><RotateCcw size={13} /></button>
                                    )}
                                  </span>
                                </td>
                              </tr>
                            )
                          })}
                        </Fragment>
                      ))}
                      {rowFilter === 'all' && days.length > 0 && (
                        <tr className="corr-add">
                          <td colSpan={6} style={{ padding: '2px 8px' }}>
                            <button type="button" className="corr-link" onClick={() => openAdd(nextDay(days[days.length - 1].date))}>
                              <Plus size={11} /> добавить дату
                            </button>
                          </td>
                        </tr>
                      )}
                      {days.length === 0 && (
                        <tr><td colSpan={6} className="text-muted" style={{ padding: 16 }}>Нет строк по этому фильтру.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {showPanelColumn && panelReport && <aside className="corr-panel">{renderPanel(panelReport)}</aside>}
                {!isMobile && (
                  <aside className="corr-diagram-col">
                    <div className="eyebrow" style={{ marginBottom: 4 }}>Схема скважины</div>
                    <CorrectionWellDiagram
                      segments={diagramSegments}
                      intervals={ribbonIntervals}
                      casings={effCasings}
                      projectedDepth={projectedDepth}
                      newEnd={newEnd}
                      origEnd={origEnd}
                      selectedId={panelId}
                      onPick={(id) => setPanelId(id)}
                    />
                    <div className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>Полоса слева — смены (цвет — мастер, штриховка — изменено, красная рамка — ошибка). Клик открывает смену.</div>
                  </aside>
                )}
              </div>

              <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Добавить дату">
                <div style={{ display: 'grid', gap: 12 }}>
                  <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
                    Будут добавлены согласованные сводки администратора за выбранные смены. Метры, диаметры, обсадку и затраты заполните в таблице и нажмите «Применить».
                  </p>
                  <label>
                    Дата
                    <input type="date" value={addDate} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setAddDate(e.target.value)} />
                  </label>
                  <div style={{ display: 'flex', gap: 16 }}>
                    {([1, 2] as const).map((x) => (
                      <label key={x} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
                        <input type="checkbox" style={{ width: 'auto' }} checked={addShifts[x]} onChange={(e) => setAddShifts((p) => ({ ...p, [x]: e.target.checked }))} /> Смена {x}
                      </label>
                    ))}
                  </div>
                  {addError && <p className="text-error" style={{ margin: 0 }}>{addError}</p>}
                  <button type="button" onClick={addDay}>Добавить в таблицу</button>
                </div>
              </Modal>

              {(isMobile || narrow) && (
                <Modal open={!!panelReport} onClose={() => setPanelId(null)} title="Смена">
                  {panelReport && renderPanel(panelReport)}
                </Modal>
              )}

              {/* итоговая панель */}
              <div className={`corr-bar${editedCount > 0 ? ' is-active' : ''}${hasErrors ? ' has-errors' : ''}`}>
                {editedCount === 0 ? (
                  <span className="text-muted" style={{ fontSize: 13 }}>Измените ячейки в таблице или откройте смену: проверка появится здесь.</span>
                ) : (
                  <>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <b>{editedCount} сводок изменено</b>
                      {val && (
                        <span className="text-muted" style={{ fontSize: 12 }}>
                          {' '}· забой {val.old_depth} → {val.new_depth} м{val.shifted > 0 ? ` · сдвинется ${val.shifted}` : ''}
                        </span>
                      )}
                      <div style={{ fontSize: 12 }}>
                        {!val ? (
                          <span className="text-muted">Проверяем…</span>
                        ) : hasErrors ? (
                          <span style={{ color: 'var(--color-danger)' }}>
                            {val.errors.length} ошибок блокируют применение{' '}
                            <button type="button" className="corr-link" onClick={() => { const first = ordered.find((r) => rowErrors.map[r.id]); if (first) setPanelId(first.id); setAllErrors(true) }}>показать →</button>
                          </span>
                        ) : (
                          <span style={{ color: needAck ? 'var(--color-warning)' : 'var(--color-success)' }}>{needAck ? `${val.warnings.length} предупреждений` : 'ошибок нет'}</span>
                        )}
                      </div>
                    </div>
                    {hasErrors && val!.errors.some((x) => x.includes('Интервалы диаметров')) && (
                      <button type="button" className="btn-outline" onClick={fitIntervals}>Подогнать диаметры</button>
                    )}
                    <button type="button" className="btn-outline" disabled={busy} onClick={discardAll}>Сбросить</button>
                    <button type="button" disabled={!canOpenConfirm || busy} onClick={() => setConfirmOpen(true)}>Применить…</button>
                  </>
                )}
              </div>

              {val && allErrors && val.errors.length > 0 && (
                <div className="card" style={{ padding: 12, marginTop: 10, borderColor: 'var(--color-danger)' }}>
                  <div className="eyebrow" style={{ marginBottom: 4 }}>Ошибки</div>
                  {val.errors.slice(0, 12).map((x, i) => (
                    <div key={i} className="corr-msg"><AlertOctagon size={14} style={{ color: 'var(--color-danger)' }} /><span>{x}</span></div>
                  ))}
                  {val.errors.length > 12 && <div className="text-muted" style={{ fontSize: 12 }}>и ещё {val.errors.length - 12} (подогнав диаметры, большинство уйдёт)</div>}
                  <button type="button" className="btn-outline" onClick={() => setAllErrors(false)} style={{ marginTop: 6, fontSize: 12, padding: '3px 10px' }}>Свернуть</button>
                </div>
              )}

              {/* подтверждение */}
              <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Применить исправления?">
                <div style={{ display: 'grid', gap: 12 }}>
                  <div className="corr-diff">
                    {ordered.filter((r) => edits[r.id]).map((r) => {
                      const ed = edits[r.id]!
                      const f = eff(r.id)
                      return (
                        <div key={r.id} className="corr-diff-row">
                          <b style={{ minWidth: 90 }}>{formatRu(f.date).slice(0, 5)}{f.shift ? ` · см. ${f.shift}` : ''}</b>
                          <div style={{ fontSize: 13 }}>
                            {'meters' in ed && <div>Метры {orig[r.id].meters} → {f.meters}</div>}
                            {'hours' in ed && <div>Часы {orig[r.id].hours || '—'} → {f.hours || '—'}</div>}
                            {'authorId' in ed && <div>Мастер {nameOf(orig[r.id].authorId)} → {nameOf(f.authorId)}</div>}
                            {'date' in ed && <div>Дата {formatRu(orig[r.id].date)} → {formatRu(f.date)}</div>}
                            {'shift' in ed && <div>Смена {orig[r.id].shift || '—'} → {f.shift || '—'}</div>}
                            {'notes' in ed && <div>Комментарий изменён</div>}
                            {'diameters' in ed && <div>Диаметры: интервалов {orig[r.id].diameters.length} → {f.diameters.length}</div>}
                            {'casings' in ed && <div>Обсадка изменена</div>}
                            {'costs' in ed && <div>Затраты изменены (статей {f.costs.length})</div>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  {val && val.warnings.map((x, i) => (
                    <div key={i} className="corr-msg"><AlertTriangle size={14} style={{ color: 'var(--color-warning)' }} /><span>{x}</span></div>
                  ))}
                  {val && val.errors.length === 0 && val.warnings.length === 0 && (
                    <div className="corr-msg"><CheckCircle2 size={14} style={{ color: 'var(--color-success)' }} /><span>Проблем не найдено.</span></div>
                  )}
                  <label>
                    Причина исправления (обязательно)
                    <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например: ошибка ввода забоя, уточнено по журналу буровой" />
                  </label>
                  {needAck && (
                    <label style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'center', color: 'var(--color-text)' }}>
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ width: 'auto' }} /> Понимаю последствия
                    </label>
                  )}
                  {error && <p className="text-error" style={{ margin: 0 }}>{error}</p>}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" style={{ flex: 1 }} disabled={!canApply} onClick={apply}>{busy ? 'Применяем…' : 'Применить'}</button>
                    <button type="button" className="btn-outline" style={{ flex: 1 }} onClick={() => setConfirmOpen(false)}>Назад</button>
                  </div>
                </div>
              </Modal>
            </>
          )}
        </>
      )}
    </div>
  )
}
