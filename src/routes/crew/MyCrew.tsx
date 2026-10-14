import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Plus, Pencil, Trash2, Users } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../context/AuthContext'
import Modal from '../../components/Modal'
import { shortName } from '../../lib/shortName'
import type { DrillingTask, Position, Worker } from '../../types/database'

type Role = 'driller' | 'assistant_driller'
interface Crew { id: string; master_id: string; name: string; drilling_task_id: string | null }
interface Member { id: string; crew_id: string; worker_id: string; role: Role; shift_number: 1 | 2 }
interface Assignment { drilling_task_id: string; worker_id: string }

const SLOTS: { role: Role; shift: 1 | 2; label: string }[] = [
  { role: 'driller', shift: 1, label: 'Буровик · смена 1' },
  { role: 'assistant_driller', shift: 1, label: 'Помощник · смена 1' },
  { role: 'driller', shift: 2, label: 'Буровик · смена 2' },
  { role: 'assistant_driller', shift: 2, label: 'Помощник · смена 2' },
]
const ACTIVE = ['in_progress', 'suspended']

// «Моя бригада» (14.10.2026): мастер заранее составляет до двух бригад
// (по одному буровику и помощнику в каждую смену), а затем ставит бригаду
// на скважину. Работник состоит только в одной бригаде и на одной скважине.
export default function MyCrew() {
  const { session, profile, loading: authLoading } = useAuth()
  const [crews, setCrews] = useState<Crew[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [wells, setWells] = useState<DrillingTask[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)

  const [editing, setEditing] = useState<Crew | 'new' | null>(null)
  const [name, setName] = useState('')
  const [pick, setPick] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [applying, setApplying] = useState<Crew | null>(null)
  const [applyWell, setApplyWell] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    if (!profile) return
    let cancelled = false
    async function load() {
      const me = profile!.id
      const [c, w, p, t] = await Promise.all([
        supabase.from('crews').select('*').eq('master_id', me).order('created_at'),
        supabase.from('workers').select('*').is('archived_at', null).order('full_name'),
        supabase.from('positions').select('*'),
        supabase.from('drilling_tasks').select('*').in('status', ACTIVE),
      ])
      const crewList = (c.data ?? []) as Crew[]
      const [m, a] = await Promise.all([
        crewList.length > 0 ? supabase.from('crew_members').select('*').in('crew_id', crewList.map((x) => x.id)) : Promise.resolve({ data: [] }),
        supabase.from('task_worker_assignments').select('drilling_task_id, worker_id').is('valid_to', null).in('role', ['driller', 'assistant_driller']),
      ])
      if (cancelled) return
      setCrews(crewList)
      setMembers((m.data ?? []) as Member[])
      setWorkers((w.data ?? []) as Worker[])
      setPositions((p.data ?? []) as Position[])
      setWells((t.data ?? []) as DrillingTask[])
      setAssignments((a.data ?? []) as Assignment[])
      setLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [profile, reload])

  const crewRoleOf = useMemo(() => new Map(positions.map((p) => [p.id, p.crew_role])), [positions])
  const wellById = useMemo(() => new Map(wells.map((x) => [x.id, x])), [wells])
  const workerById = useMemo(() => new Map(workers.map((x) => [x.id, x])), [workers])

  if (authLoading || loading) return <p>Загрузка…</p>
  if (!session) return <Navigate to="/login" replace />
  if (!profile || profile.role !== 'party_chief') return <p>Раздел для мастеров.</p>

  const me = profile.id
  const myWells = wells.filter((x) => x.foreman_id === me)
  const wellsWithCrew = new Set(assignments.filter((a) => wellById.has(a.drilling_task_id)).map((x) => x.drilling_task_id))
  const wellsWithoutCrew = myWells.filter((x) => !wellsWithCrew.has(x.id))
  const deployedWell = (c: Crew) => (c.drilling_task_id ? wellById.get(c.drilling_task_id) ?? null : null)
  // занят — только на скважине в работе (открытые назначения на закрытых скважинах не в счёт)
  const busyWorkerIds = new Set(assignments.filter((a) => wellById.has(a.drilling_task_id)).map((a) => a.worker_id))

  function openEdit(c: Crew | 'new') {
    setEditing(c)
    setError(null)
    if (c === 'new') {
      setName(`Бригада ${crews.length + 1}`)
      setPick({})
    } else {
      setName(c.name)
      const next: Record<string, string> = {}
      for (const m of members.filter((x) => x.crew_id === c.id)) next[`${m.role}:${m.shift_number}`] = m.worker_id
      setPick(next)
    }
  }

  function optionsFor(role: Role, currentCrewId: string | null) {
    const inOtherCrews = new Set(members.filter((m) => m.crew_id !== currentCrewId).map((m) => m.worker_id))
    return workers.filter(
      (w) =>
        crewRoleOf.get(w.position_id ?? '') === role &&
        (w.assigned_foreman_id == null || w.assigned_foreman_id === me) &&
        !inOtherCrews.has(w.id) &&
        !busyWorkerIds.has(w.id),
    )
  }

  const chosen = Object.values(pick).filter(Boolean)
  const hasDuplicate = new Set(chosen).size !== chosen.length

  async function save() {
    if (!editing) return
    setBusy(true)
    setError(null)
    let crewId: string
    if (editing === 'new') {
      const { data, error: e } = await supabase.from('crews').insert({ master_id: me, name: name.trim() }).select().single()
      if (e || !data) {
        setBusy(false)
        return setError(e?.message ?? 'Не удалось создать бригаду')
      }
      crewId = data.id as string
    } else {
      crewId = editing.id
      await supabase.from('crews').update({ name: name.trim() }).eq('id', crewId)
      await supabase.from('crew_members').delete().eq('crew_id', crewId)
    }
    const rows = SLOTS.filter((s) => pick[`${s.role}:${s.shift}`]).map((s) => ({
      crew_id: crewId,
      worker_id: pick[`${s.role}:${s.shift}`],
      role: s.role,
      shift_number: s.shift,
    }))
    if (rows.length > 0) {
      const { error: e } = await supabase.from('crew_members').insert(rows)
      if (e) {
        setBusy(false)
        setReload((x) => x + 1)
        return setError(e.message)
      }
    }
    setBusy(false)
    setEditing(null)
    setReload((x) => x + 1)
  }

  async function remove(id: string) {
    const { error: e } = await supabase.from('crews').delete().eq('id', id)
    setConfirmDelete(null)
    if (e) setError(e.message)
    setReload((x) => x + 1)
  }

  async function apply() {
    if (!applying || !applyWell) return
    setBusy(true)
    setError(null)
    const { error: e } = await supabase.rpc('apply_crew_to_well', { p_crew: applying.id, p_task: applyWell })
    setBusy(false)
    if (e) return setError(e.message)
    setApplying(null)
    setApplyWell('')
    setReload((x) => x + 1)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Users size={24} className="text-muted" /> Моя бригада
        </h1>
        <button type="button" disabled={crews.length >= 2} onClick={() => openEdit('new')} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={16} /> Добавить бригаду
        </button>
      </div>
      <p className="text-muted" style={{ margin: '8px 0 20px' }}>
        До двух бригад: по одному буровику и помощнику в каждую смену. Работник числится только в одной бригаде и на одной скважине.
        Пока на скважине нет бригады, сводки по ней подать нельзя.
      </p>
      {error && !editing && !applying && <p className="text-error">{error}</p>}

      {wellsWithoutCrew.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 14, borderColor: 'var(--color-warning)' }}>
          Без бригады: {wellsWithoutCrew.map((x) => `№${x.well_number}`).join(', ')}. Поставьте на них бригаду, иначе сводки недоступны.
        </div>
      )}

      {crews.length === 0 ? (
        <p className="text-muted">Бригад пока нет. Нажмите «Добавить бригаду».</p>
      ) : (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {crews.map((c) => {
            const well = deployedWell(c)
            const cm = members.filter((m) => m.crew_id === c.id)
            const deployed = well != null && wellsWithCrew.has(well.id)
            return (
              <div key={c.id} className="card" style={{ padding: 14, display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <b>{c.name}</b>
                  <span className={`badge ${deployed ? 'badge-success' : 'badge-neutral'}`}>{deployed ? `на скважине №${well!.well_number}` : 'свободна'}</span>
                </div>
                {[1, 2].map((shift) => (
                  <div key={shift} style={{ fontSize: 13 }}>
                    <span className="text-muted">Смена {shift}: </span>
                    {cm.filter((m) => m.shift_number === shift).map((m) => `${shortName(workerById.get(m.worker_id)?.full_name)} (${m.role === 'driller' ? 'буровик' : 'помощник'})`).join(', ') || '—'}
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {!deployed && (
                    <>
                      <button type="button" className="btn-outline" onClick={() => openEdit(c)} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13 }}>
                        <Pencil size={14} /> Состав
                      </button>
                      {wellsWithoutCrew.length > 0 && cm.length > 0 && (
                        <button type="button" onClick={() => { setApplying(c); setApplyWell(wellsWithoutCrew[0].id); setError(null) }} style={{ fontSize: 13 }}>
                          Поставить на скважину
                        </button>
                      )}
                      {confirmDelete === c.id ? (
                        <>
                          <button type="button" className="btn-danger" onClick={() => void remove(c.id)} style={{ fontSize: 13 }}>Удалить?</button>
                          <button type="button" className="btn-outline" onClick={() => setConfirmDelete(null)} style={{ fontSize: 13 }}>Отмена</button>
                        </>
                      ) : (
                        <button type="button" className="btn-outline" onClick={() => setConfirmDelete(c.id)} aria-label="Удалить бригаду" style={{ display: 'flex', alignItems: 'center' }}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </>
                  )}
                  {deployed && well && (
                    <Link to={`/tasks/drilling/${well.id}/dashboard`} style={{ fontSize: 13 }}>
                      Состав на скважине меняется в «Составе бригады» →
                    </Link>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal open={editing != null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Новая бригада' : 'Состав бригады'}>
        <div style={{ display: 'grid', gap: 12 }}>
          <label>
            Название
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {SLOTS.map((s) => {
            const key = `${s.role}:${s.shift}`
            const crewId = editing && editing !== 'new' ? editing.id : null
            const opts = optionsFor(s.role, crewId)
            return (
              <label key={key}>
                {s.label}
                <select value={pick[key] ?? ''} onChange={(e) => setPick((prev) => ({ ...prev, [key]: e.target.value }))}>
                  <option value="">Не назначать</option>
                  {opts.map((w) => (
                    <option key={w.id} value={w.id}>{shortName(w.full_name)}</option>
                  ))}
                  {pick[key] && !opts.some((w) => w.id === pick[key]) && (
                    <option value={pick[key]}>{shortName(workerById.get(pick[key])?.full_name)}</option>
                  )}
                </select>
              </label>
            )
          })}
          <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
            В списках только свободные работники нужной должности из вашей бригады и без бригады. Состав можно оставить пустым и заполнить позже.
          </p>
          {hasDuplicate && <p className="text-error" style={{ margin: 0 }}>Один работник выбран дважды.</p>}
          {error && <p className="text-error" style={{ margin: 0 }}>{error}</p>}
          <button type="button" disabled={busy || hasDuplicate || !name.trim()} onClick={() => void save()}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </Modal>

      <Modal open={applying != null} onClose={() => setApplying(null)} title={applying ? `Поставить «${applying.name}» на скважину` : ''}>
        <div style={{ display: 'grid', gap: 12 }}>
          <label>
            Скважина
            <select value={applyWell} onChange={(e) => setApplyWell(e.target.value)}>
              {wellsWithoutCrew.map((x) => (
                <option key={x.id} value={x.id}>№{x.well_number}</option>
              ))}
            </select>
          </label>
          {error && <p className="text-error" style={{ margin: 0 }}>{error}</p>}
          <button type="button" disabled={busy || !applyWell} onClick={() => void apply()}>
            {busy ? 'Ставим…' : 'Поставить бригаду'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
