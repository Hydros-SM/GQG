import { useEffect, useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import Modal from './Modal'
import type { DrillingTask, Position, Worker } from '../types/database'
import { shortName } from '../lib/shortName'

type Role = 'driller' | 'assistant_driller'
const SLOTS: { role: Role; shift: 1 | 2; label: string }[] = [
  { role: 'driller', shift: 1, label: 'Буровик · смена 1' },
  { role: 'driller', shift: 2, label: 'Буровик · смена 2' },
  { role: 'assistant_driller', shift: 1, label: 'Помощник · смена 1' },
  { role: 'assistant_driller', shift: 2, label: 'Помощник · смена 2' },
]

interface Props {
  plannedWells: DrillingTask[]
  onStarted: (updated: DrillingTask) => void
}

const todayIso = () => new Date().toISOString().slice(0, 10)

// Мастер сам берёт в работу запланированную скважину (07.10.2026): кнопка
// «Начать бурение» доступна, когда у мастера нет скважин в работе. Список
// запланированных → «Приступить к заданию» → дата бурения и состав бригады
// (только машинисты-буровики и помощники, по должностям из справочника).
export default function MasterStartDrilling({ plannedWells, onStarted }: Props) {
  const { profile } = useAuth()
  const [activeCount, setActiveCount] = useState<number | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const [well, setWell] = useState<DrillingTask | null>(null)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [date, setDate] = useState(todayIso())
  const [pick, setPick] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!profile || profile.role !== 'party_chief') return
    supabase
      .from('drilling_tasks')
      .select('id')
      .eq('foreman_id', profile.id)
      .in('status', ['in_progress', 'suspended'])
      .then(({ data }) => setActiveCount((data ?? []).length))
  }, [profile])

  useEffect(() => {
    if (!well) return
    Promise.all([
      supabase.from('workers').select('*').is('archived_at', null).order('full_name'),
      supabase.from('positions').select('*'),
    ]).then(([w, p]) => {
      setWorkers((w.data ?? []) as Worker[])
      setPositions((p.data ?? []) as Position[])
    })
  }, [well])

  const crewRoleOf = useMemo(() => new Map(positions.map((p) => [p.id, p.crew_role])), [positions])
  const posName = useMemo(() => new Map(positions.map((p) => [p.id, p.name])), [positions])

  if (!profile || profile.role !== 'party_chief') return null
  // кнопка нужна, только если у мастера нет скважин в работе и есть что запускать
  if (activeCount === null || activeCount >= 2 || plannedWells.length === 0) return null

  // доступные работники: моя бригада и без бригады (чужих не берём)
  const available = (role: Role) =>
    workers.filter((w) => crewRoleOf.get(w.position_id ?? '') === role && (w.assigned_foreman_id == null || w.assigned_foreman_id === profile.id))

  const chosen = Object.values(pick).filter(Boolean)
  const hasDuplicate = new Set(chosen.filter((v) => Object.values(pick).filter((x) => x === v).length > 1)).size > 0
  const nDriller = SLOTS.filter((s) => s.role === 'driller' && pick[`${s.role}:${s.shift}`]).length
  const nAssistant = SLOTS.filter((s) => s.role === 'assistant_driller' && pick[`${s.role}:${s.shift}`]).length
  const crewOk = nDriller > 0 && nAssistant > 0 && !hasDuplicate

  function openWell(t: DrillingTask) {
    setWell(t)
    setListOpen(false)
    setDate(todayIso())
    setPick({})
    setError(null)
  }

  async function handleStart() {
    if (!well || !crewOk) return
    setBusy(true)
    setError(null)
    const crew = SLOTS.filter((s) => pick[`${s.role}:${s.shift}`]).map((s) => ({
      worker_id: pick[`${s.role}:${s.shift}`],
      role: s.role,
      shift: s.shift,
    }))
    const { error: rpcError } = await supabase.rpc('start_planned_well', { p_task: well.id, p_start: date, p_crew: crew })
    if (rpcError) {
      setBusy(false)
      setError(rpcError.message)
      return
    }
    const { data: fresh } = await supabase.from('drilling_tasks').select('*').eq('id', well.id).single()
    setBusy(false)
    if (fresh) onStarted(fresh as DrillingTask)
    setWell(null)
    setActiveCount(1)
  }

  return (
    <>
      <div style={{ margin: '16px 0 24px' }}>
        <button type="button" onClick={() => setListOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Play size={15} /> Начать бурение
        </button>
      </div>

      <Modal open={listOpen} onClose={() => setListOpen(false)} title="Запланированные скважины">
        <div style={{ display: 'grid', gap: 8 }}>
          {plannedWells.map((t) => (
            <div key={t.id} className="card" style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <div style={{ fontWeight: 600 }}>№{t.well_number}</div>
                <div className="text-muted" style={{ fontSize: 12 }}>
                  {t.projected_depth != null ? `Проект ${t.projected_depth} м` : 'Глубина не задана'}
                  {t.angle != null ? ` · угол ${t.angle}°` : ''}
                </div>
              </div>
              <button type="button" onClick={() => openWell(t)}>
                Приступить к заданию
              </button>
            </div>
          ))}
        </div>
      </Modal>

      <Modal open={!!well} onClose={() => setWell(null)} title={well ? `Приступить: скважина №${well.well_number}` : ''}>
        <div style={{ display: 'grid', gap: 12 }}>
          <label>
            Дата начала бурения
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <div className="eyebrow">Бригада</div>
          {SLOTS.map((s) => {
            const key = `${s.role}:${s.shift}`
            const options = available(s.role)
            return (
              <label key={key}>
                {s.label}
                <select value={pick[key] ?? ''} onChange={(e) => setPick((prev) => ({ ...prev, [key]: e.target.value }))}>
                  <option value="">{s.shift === 1 ? 'Выберите работника…' : 'Не назначать'}</option>
                  {options.map((w) => (
                    <option key={w.id} value={w.id}>
                      {shortName(w.full_name)}
                      {w.assigned_foreman_id ? ' · моя бригада' : ' · без бригады'}
                      {posName.get(w.position_id ?? '') ? ` · ${posName.get(w.position_id ?? '')}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )
          })}
          {hasDuplicate && <p className="text-error" style={{ margin: 0 }}>Один работник выбран дважды.</p>}
          {!crewOk && !hasDuplicate && (
            <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
              Нужен хотя бы один машинист-буровик и один помощник. В списке только работники с этими должностями из вашей бригады и без бригады.
            </p>
          )}
          {error && <p className="text-error" style={{ margin: 0 }}>{error}</p>}
          <button type="button" disabled={busy || !crewOk} onClick={handleStart}>
            {busy ? 'Запускаем…' : 'Приступить к заданию'}
          </button>
        </div>
      </Modal>
    </>
  )
}
