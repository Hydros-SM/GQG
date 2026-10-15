import { useEffect, useState } from 'react'
import { isMasterProfile } from '../../lib/masters'
import { Link } from 'react-router-dom'
import { ClipboardCheck, Undo2, CalendarOff, Clock } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { round2 } from '../../lib/taskProgress'
import { addDaysIso, formatRu, stayInfo, todayIso } from '../../lib/workerStay'
import type { DrillingTask, Position, Profile, WorkerStay } from '../../types/database'
import { shortName } from '../../lib/shortName'

interface Rep {
  id: string
  report_date: string
  shift_number: number | null
  drilling_task_id: string
  drilling_meters: number | null
  approval_status: string
  edit_unlocked: boolean
  author_id: string
}

interface EventItem {
  at: string
  text: string
}

// Верх дашборда руководства (08.10.2026): главные числа, что требует
// внимания, метры по дням, вахты, активные скважины и лента событий.
export default function ManagementOverview({ pendingApprovals }: { pendingApprovals: number }) {
  const [tasks, setTasks] = useState<DrillingTask[]>([])
  const [reports, setReports] = useState<Rep[]>([])
  const [chiefs, setChiefs] = useState<Profile[]>([])
  const [stays, setStays] = useState<WorkerStay[]>([])
  const [events, setEvents] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [tRes, rRes, pRes, sRes, lRes, hRes, posRes] = await Promise.all([
        supabase.from('drilling_tasks').select('*'),
        supabase
          .from('reports')
          .select('id, report_date, shift_number, drilling_task_id, drilling_meters, approval_status, edit_unlocked, author_id')
          .not('drilling_task_id', 'is', null),
        supabase.from('profiles').select('*').eq('role', 'party_chief').order('full_name'),
        supabase.from('worker_stays').select('*').is('departed_on', null),
        supabase.from('report_status_log').select('report_id, action, created_at').order('created_at', { ascending: false }).limit(8),
        supabase.from('shift_handovers').select('from_name, to_name, created_at').order('created_at', { ascending: false }).limit(3),
        supabase.from('positions').select('*'),
      ])
      if (cancelled) return
      const taskList = (tRes.data ?? []) as DrillingTask[]
      const repList = (rRes.data ?? []) as Rep[]
      setTasks(taskList)
      setReports(repList)
      setChiefs(((pRes.data ?? []) as Profile[]).filter((x) => isMasterProfile(x, (posRes.data ?? []) as Position[])))
      setStays((sRes.data ?? []) as WorkerStay[])
      const wellOf = new Map(taskList.map((t) => [t.id, t.well_number]))
      const repOf = new Map(repList.map((r) => [r.id, r]))
      const verbs: Record<string, string> = { approved: 'согласована', returned: 'возвращена мастеру', rejected: 'отклонена', submitted: 'отправлена на согласование', resubmitted: 'отправлена повторно' }
      const ev: EventItem[] = []
      for (const l of lRes.data ?? []) {
        const r = repOf.get(l.report_id as string)
        if (!r) continue
        ev.push({ at: l.created_at as string, text: `Сводка ${wellOf.get(r.drilling_task_id) ?? ''}${r.shift_number ? ` · смена ${r.shift_number}` : ''} ${verbs[l.action as string] ?? ''}` })
      }
      for (const h of hRes.data ?? []) ev.push({ at: h.created_at as string, text: `Передача вахты: ${h.from_name} → ${h.to_name}` })
      ev.sort((a, b) => b.at.localeCompare(a.at))
      setEvents(ev.slice(0, 6))
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return <div className="skeleton" style={{ height: 160, borderRadius: 'var(--radius-md)', marginBottom: 20 }} />
  }

  const today = todayIso()
  const yesterday = addDaysIso(today, -1)
  const approved = reports.filter((r) => r.approval_status === 'approved')
  const sumOn = (from: string, to: string) =>
    round2(approved.filter((r) => r.report_date >= from && r.report_date <= to).reduce((s, r) => s + (r.drilling_meters ?? 0), 0))
  const yMeters = sumOn(yesterday, yesterday)
  const w7 = sumOn(addDaysIso(today, -6), today)
  const w7prev = sumOn(addDaysIso(today, -13), addDaysIso(today, -7))
  const avg7 = w7 / 7
  const yDiff = avg7 > 0 ? Math.round(((yMeters - avg7) / avg7) * 100) : null
  const totalApproved = round2(approved.reduce((s, r) => s + (r.drilling_meters ?? 0), 0))
  const totalPlan = tasks.reduce((s, t) => s + (t.projected_depth ?? 0), 0)
  const pct = totalPlan > 0 ? Math.round((totalApproved / totalPlan) * 100) : 0
  const active = tasks.filter((t) => t.status === 'in_progress')
  const planned = tasks.filter((t) => t.status === 'planned').length

  const returned = reports.filter((r) => r.approval_status === 'rejected' && r.edit_unlocked).length
  const missing: { id: string; label: string }[] = []
  for (const t of active) {
    if (t.start_date && t.start_date > yesterday) continue
    for (const shift of [1, 2]) {
      const has = reports.some((r) => r.drilling_task_id === t.id && r.report_date === yesterday && r.shift_number === shift)
      if (!has) missing.push({ id: t.id, label: `${t.well_number} · смена ${shift}` })
    }
  }
  const overtime = stays.filter((s) => stayInfo(s).overtime > 0).length

  // метры по дням за 14 дней
  const days = Array.from({ length: 14 }, (_, i) => {
    const date = addDaysIso(today, i - 13)
    return { date, m: sumOn(date, date) }
  })
  const planDaily = active.reduce((s, t) => s + (t.planned_daily_meters ?? 0), 0)
  const maxBar = Math.max(...days.map((d) => d.m), planDaily, 10)

  const nameOf = new Map(chiefs.map((c) => [c.id, shortName(c.full_name)]))
  const wellsRows = active.map((t) => {
    const mine = approved.filter((r) => r.drilling_task_id === t.id)
    const depth = round2(mine.reduce((s, r) => s + (r.drilling_meters ?? 0), 0))
    const start = t.start_date ?? mine[0]?.report_date ?? today
    const daysOn = Math.max(1, Math.round((new Date(today).getTime() - new Date(start).getTime()) / 86400000) + 1)
    const hasToday = reports.some((r) => r.drilling_task_id === t.id && r.report_date === today)
    return { t, depth, pace: round2(depth / daysOn), hasToday }
  })

  const kpi = (label: string, value: string, sub?: string, subColor?: string) => (
    <div className="card dash-kpi">
      <div className="eyebrow">{label}</div>
      <div className="num dash-kpi-v">{value}</div>
      {sub && <div className="text-muted" style={{ fontSize: 12, color: subColor }}>{sub}</div>}
    </div>
  )

  const attentionRow = (icon: React.ReactNode, text: string, value: React.ReactNode, to?: string) => {
    const inner = (
      <>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{icon}{text}</span>
        <b className="num">{value}</b>
      </>
    )
    return to ? (
      <Link to={to} className="dash-row dash-row-link">{inner}</Link>
    ) : (
      <div className="dash-row">{inner}</div>
    )
  }
  const anyAttention = pendingApprovals > 0 || returned > 0 || missing.length > 0 || overtime > 0

  return (
    <div style={{ display: 'grid', gap: 14, marginBottom: 24 }}>
      <div className="dash-kpis">
        {kpi('Пробурено вчера', `${yMeters} м`, yDiff == null ? undefined : `${yDiff > 0 ? '+' : ''}${yDiff}% к среднему за 7 дн.`, yDiff != null && yDiff < 0 ? 'var(--color-danger)' : 'var(--color-success)')}
        {kpi('За 7 дней', `${w7} м`, `прошлые 7 дн.: ${w7prev} м`)}
        {kpi('Проект', `${pct}%`, `${totalApproved} из ${round2(totalPlan)} м`)}
        {kpi('Активные скважины', String(active.length), `всего ${tasks.length} · в плане ${planned}`)}
      </div>

      <div className="card" style={{ padding: 14, borderColor: anyAttention ? 'var(--color-warning)' : undefined }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Требует внимания</div>
        {!anyAttention && <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>Всё в порядке: нет сводок на согласовании, возвратов и пропусков за вчера.</p>}
        {pendingApprovals > 0 && attentionRow(<ClipboardCheck size={15} style={{ color: 'var(--color-primary)' }} />, 'Сводок на согласовании', pendingApprovals, '/reports/pending')}
        {returned > 0 && attentionRow(<Undo2 size={15} style={{ color: 'var(--color-warning)' }} />, 'Возвращено мастерам, не исправлено', returned)}
        {missing.length > 0 &&
          attentionRow(
            <CalendarOff size={15} style={{ color: 'var(--color-danger)' }} />,
            `Нет сводки за вчера (${formatRu(yesterday).slice(0, 5)})`,
            missing.slice(0, 2).map((m) => m.label).join(', ') + (missing.length > 2 ? ` +${missing.length - 2}` : ''),
            `/tasks/drilling/${missing[0].id}/reports`,
          )}
        {overtime > 0 && attentionRow(<Clock size={15} style={{ color: 'var(--color-warning)' }} />, 'В переработке на вахте', `${overtime} чел.`, '/org-chart')}
      </div>

      <div className="dash-split">
        <div className="card" style={{ padding: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Метры по дням, 14 дней</div>
          <svg viewBox="0 0 300 100" style={{ width: '100%', display: 'block' }} role="img">
            <title>Метры по дням</title>
            <desc>Столбики согласованных метров за 14 дней и линия планового темпа</desc>
            {days.map((d, i) => {
              const h = (d.m / maxBar) * 84
              return <rect key={d.date} x={4 + i * 21} y={90 - h} width={15} height={Math.max(h, d.m > 0 ? 1 : 0)} fill="var(--color-primary)" />
            })}
            {planDaily > 0 && (
              <line x1={0} x2={300} y1={90 - (planDaily / maxBar) * 84} y2={90 - (planDaily / maxBar) * 84} stroke="var(--color-text-faint)" strokeDasharray="4 3" />
            )}
            <text x={4} y={99} fontSize={7} fill="var(--color-text-muted)">{formatRu(days[0].date).slice(0, 5)}</text>
            <text x={296} y={99} fontSize={7} textAnchor="end" fill="var(--color-text-muted)">{formatRu(days[13].date).slice(0, 5)}</text>
          </svg>
          {planDaily > 0 && <div className="text-muted" style={{ fontSize: 12 }}>пунктир — плановый темп {round2(planDaily)} м/сут по активным скважинам</div>}
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Кто на вахте</div>
          {chiefs.map((c) => (
            <div key={c.id} className="dash-row">
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <i className="dash-dot" data-on={c.on_duty ? '1' : '0'} />
                {shortName(c.full_name)}
              </span>
              <span className="text-muted" style={{ fontSize: 12 }}>
                {tasks.filter((t) => t.foreman_id === c.id && t.status === 'in_progress').map((t) => t.well_number).join(', ') || (c.on_duty ? 'на вахте' : 'межвахта')}
              </span>
            </div>
          ))}
        </div>
      </div>

      {wellsRows.length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Активные скважины</div>
          {wellsRows.map(({ t, depth, pace, hasToday }) => (
            <Link key={t.id} to={`/tasks/drilling/${t.id}/dashboard`} className="dash-row dash-row-link">
              <span>
                <b>№{t.well_number}</b>{' '}
                <span className="text-muted" style={{ fontSize: 12 }}>{nameOf.get(t.foreman_id ?? '') ?? '—'}</span>
              </span>
              <span className="text-muted" style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <span className="num">{depth}{t.projected_depth ? ` / ${round2(t.projected_depth)}` : ''} м · {pace} м/сут</span>
                <span className={`badge badge-${hasToday ? 'success' : 'danger'}`}>{hasToday ? 'сводка есть' : 'нет сводки'}</span>
              </span>
            </Link>
          ))}
        </div>
      )}

      {events.length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Последние события</div>
          {events.map((e, i) => (
            <div key={i} className="dash-row">
              <span>{e.text}</span>
              <span className="text-muted num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                {new Date(e.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
