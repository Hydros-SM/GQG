import { useEffect, useState } from 'react'
import { useWellHasCrew } from '../../hooks/useWellHasCrew'
import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../context/AuthContext'
import { round2 } from '../../lib/taskProgress'
import { formatRu, stayInfo, todayIso } from '../../lib/workerStay'
import MasterStartDrilling from '../MasterStartDrilling'
import type { DrillingTask, Report, Worker, WorkerStay } from '../../types/database'
import { shortName } from '../../lib/shortName'

// Верх дашборда мастера (08.10.2026): одна главная задача на сегодня —
// «Моя скважина» с кнопкой новой сводки, что нужно исправить, бригада и
// последние решения по сводкам.
export default function MasterOverview() {
  const { profile, canCreateWells } = useAuth()
  const [wells, setWells] = useState<DrillingTask[]>([])
  const [planned, setPlanned] = useState<DrillingTask[]>([])
  const [wellReports, setWellReports] = useState<Report[]>([])
  const [mine, setMine] = useState<Report[]>([])
  const [crew, setCrew] = useState<(Worker & { stay: WorkerStay | null })[]>([])
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const hasCrew = useWellHasCrew(wells[0]?.id, wells.length > 0, reload)

  useEffect(() => {
    if (!profile) return
    let cancelled = false
    async function load() {
      const me = profile!.id
      const [wRes, pRes, mRes, crewRes] = await Promise.all([
        supabase.from('drilling_tasks').select('*').eq('foreman_id', me).in('status', ['in_progress', 'suspended']),
        supabase.from('drilling_tasks').select('*').eq('status', 'planned'),
        supabase.from('reports').select('*').eq('author_id', me).order('report_date', { ascending: false }).limit(60),
        supabase.from('workers').select('*').eq('assigned_foreman_id', me).is('archived_at', null).order('full_name'),
      ])
      if (cancelled) return
      const wellList = (wRes.data ?? []) as DrillingTask[]
      setWells(wellList)
      setPlanned((pRes.data ?? []) as DrillingTask[])
      setMine((mRes.data ?? []) as Report[])
      const workers = (crewRes.data ?? []) as Worker[]
      const ids = workers.map((w) => w.id)
      const [{ data: st }, { data: wr }] = await Promise.all([
        ids.length > 0 ? supabase.from('worker_stays').select('*').in('worker_id', ids).is('departed_on', null) : Promise.resolve({ data: [] }),
        wellList.length > 0 ? supabase.from('reports').select('*').eq('drilling_task_id', wellList[0].id) : Promise.resolve({ data: [] }),
      ])
      if (cancelled) return
      setCrew(workers.map((w) => ({ ...w, stay: ((st ?? []) as WorkerStay[]).find((x) => x.worker_id === w.id) ?? null })))
      setWellReports((wr ?? []) as Report[])
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [profile, reload])

  if (loading) return <div className="skeleton" style={{ height: 140, borderRadius: 'var(--radius-md)', marginBottom: 20 }} />

  const today = todayIso()
  const well = wells[0] ?? null
  const approvedDepth = well ? round2(wellReports.filter((r) => r.approval_status === 'approved').reduce((s, r) => s + (r.drilling_meters ?? 0), 0)) : 0
  const pendingDepth = well ? round2(wellReports.filter((r) => r.approval_status === 'submitted').reduce((s, r) => s + (r.drilling_meters ?? 0), 0)) : 0
  const pct = well?.projected_depth ? Math.min(100, Math.round((approvedDepth / well.projected_depth) * 100)) : 0
  const sentToday = [1, 2].filter((s) => wellReports.some((r) => r.report_date === today && r.shift_number === s && r.approval_status !== 'draft'))
  const nextShift = [1, 2].find((s) => !wellReports.some((r) => r.report_date === today && r.shift_number === s))
  const fix = mine.filter((r) => (r.approval_status === 'rejected' && r.edit_unlocked) || r.approval_status === 'draft')
  const decided = mine.filter((r) => r.approved_at && (r.approval_status === 'approved' || r.approval_status === 'rejected')).sort((a, b) => (b.approved_at ?? '').localeCompare(a.approved_at ?? '')).slice(0, 3)
  const wellNumberOf = new Map(wells.map((w) => [w.id, w.well_number]))
  const crewRows = crew
    .map((w) => ({ w, info: w.stay ? stayInfo(w.stay) : null }))
    .sort((a, b) => (b.info?.overtime ?? -1) - (a.info?.overtime ?? -1))
    .slice(0, 6)

  return (
    <div style={{ display: 'grid', gap: 12, marginBottom: 24 }}>
      {well ? (
        <div className="card" style={{ padding: 16, borderColor: 'var(--color-accent)' }}>
          <div className="eyebrow">Моя скважина</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, margin: '2px 0 6px' }}>
            <Link to={`/tasks/drilling/${well.id}/dashboard`} style={{ fontSize: 20, fontWeight: 700, fontStyle: 'italic', color: 'var(--color-text)' }}>№{well.well_number}</Link>
            <span className="org-duty" data-on={profile?.on_duty ? '1' : '0'}><i />{profile?.on_duty ? 'на вахте' : 'не на вахте'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span className="num">Забой {approvedDepth}{pendingDepth > 0 ? ` (+${pendingDepth})` : ''} м</span>
            <span className="text-muted num">{well.projected_depth ? `${pct}% · проект ${round2(well.projected_depth)} м` : ''}</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--color-surface-muted)', overflow: 'hidden', marginTop: 6 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-primary)' }} />
          </div>
          <div className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>
            Сегодня: {sentToday.length === 0 ? 'сводок пока нет' : `отправлено — смена ${sentToday.join(', ')}`}
            {nextShift ? ` · нет сводки за смену ${nextShift}` : ' · все смены внесены'}
          </div>
          {nextShift && hasCrew === false && (
            <Link to="/my-crew" style={{ display: 'block', marginTop: 10 }}>
              <button type="button" style={{ width: '100%' }}>Составьте бригаду, чтобы подать сводку</button>
            </Link>
          )}
          {nextShift && hasCrew !== false && (
            <Link to={`/tasks/drilling/${well.id}/reports/new?shift=${nextShift}`} style={{ display: 'block', marginTop: 10 }}>
              <button type="button" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Plus size={15} /> Новая сводка (смена {nextShift})
              </button>
            </Link>
          )}
        </div>
      ) : (
        <div className="card" style={{ padding: 16 }}>
          <div className="eyebrow">Моя скважина</div>
          <p style={{ margin: '6px 0 0', fontSize: 14 }}>Сейчас у вас нет скважины в работе.</p>
          {planned.length > 0 ? (
            <MasterStartDrilling plannedWells={planned} onStarted={() => setReload((x) => x + 1)} />
          ) : (
            <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>Запланированных скважин пока нет.</p>
          )}
          {canCreateWells && (
            <Link to="/sites" style={{ display: 'inline-block', marginTop: 10, fontSize: 13 }}>
              Создать новую скважину: выберите участок →
            </Link>
          )}
        </div>
      )}

      {fix.length > 0 && (
        <div className="card" style={{ padding: 14, borderColor: 'var(--color-warning)' }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Нужно исправить</div>
          {fix.slice(0, 5).map((r) => (
            <Link key={r.id} to={`/tasks/drilling/${r.drilling_task_id}/reports/${r.id}/edit`} className="dash-row dash-row-link">
              <span>
                №{wellNumberOf.get(r.drilling_task_id ?? '') ?? ''} · {formatRu(r.report_date).slice(0, 5)}{r.shift_number ? ` · смена ${r.shift_number}` : ''}
              </span>
              <span className="text-muted" style={{ fontSize: 12 }}>
                {r.approval_status === 'draft' ? 'черновик, не отправлен' : r.review_comment ? `«${r.review_comment}»` : 'возвращена на правку'}
              </span>
            </Link>
          ))}
        </div>
      )}

      {crewRows.length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Моя бригада</div>
          {crewRows.map(({ w, info }) => (
            <div key={w.id} className="dash-row">
              <span>{shortName(w.full_name)}</span>
              {info ? (
                info.overtime > 0 ? (
                  <span className="badge badge-warning">+{info.overtime} дн. переработки</span>
                ) : (
                  <span className="text-muted" style={{ fontSize: 12 }}>выезд через {info.remaining} дн.</span>
                )
              ) : (
                <span className="text-muted" style={{ fontSize: 12 }}>вахта не заведена</span>
              )}
            </div>
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Последние решения</div>
          {decided.map((r) => (
            <Link key={r.id} to={`/tasks/drilling/${r.drilling_task_id}/reports/${r.id}`} className="dash-row dash-row-link">
              <span>{formatRu(r.report_date).slice(0, 5)}{r.shift_number ? ` · смена ${r.shift_number}` : ''}</span>
              <span className={`badge badge-${r.approval_status === 'approved' ? 'success' : 'danger'}`}>
                {r.approval_status === 'approved' ? 'согласована' : 'возвращена'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
