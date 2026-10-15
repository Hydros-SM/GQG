import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import Modal from './Modal'
import AreaFilterHint from './AreaFilterHint'
import { useAreaCandidates } from '../hooks/useAreaCandidates'
import type { DrillingOrganization, DrillingRig, DrillingTask } from '../types/database'
import { shortName } from '../lib/shortName'

// «Запустить бурение» на запланированной скважине (04.10.2026): назначаем то,
// чего не было при планировании — организацию, станок, бригадира, дату начала
// и (по желанию) план бурения, и переводим скважину в статус «В работе».
export default function StartDrillingModal({
  well,
  open,
  onClose,
  onStarted,
}: {
  well: DrillingTask
  open: boolean
  onClose: () => void
  onStarted: (updated: DrillingTask) => void
}) {
  const [orgs, setOrgs] = useState<DrillingOrganization[]>([])
  const [rigs, setRigs] = useState<DrillingRig[]>([])
  const [orgId, setOrgId] = useState(well.drilling_org_id ?? '')
  const [rigId, setRigId] = useState(well.drilling_rig_id ?? '')
  const [foremanId, setForemanId] = useState(well.foreman_id ?? '')
  const [startDate, setStartDate] = useState(well.start_date ?? new Date().toISOString().slice(0, 10))
  const [daily, setDaily] = useState(well.planned_daily_meters != null ? String(well.planned_daily_meters) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pick = useAreaCandidates('drilling', foremanId ? [foremanId] : [], true)

  useEffect(() => {
    if (!open) return
    Promise.all([
      supabase.from('drilling_organizations').select('*').order('name'),
      supabase.from('drilling_rigs').select('*').order('rig_number'),
    ]).then(([o, r]) => {
      setOrgs((o.data ?? []) as DrillingOrganization[])
      setRigs((r.data ?? []) as DrillingRig[])
    })
  }, [open])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const { data, error: updError } = await supabase
      .from('drilling_tasks')
      .update({
        status: 'in_progress',
        drilling_org_id: orgId,
        drilling_rig_id: rigId || null,
        foreman_id: foremanId,
        start_date: startDate || null,
        planned_daily_meters: daily ? Number(daily) : null,
      })
      .eq('id', well.id)
      .select()
    setSaving(false)
    if (updError) {
      setError(updError.message)
      return
    }
    if (!data || data.length === 0) {
      setError('Не удалось запустить бурение: нет прав на изменение.')
      return
    }
    onStarted(data[0] as DrillingTask)
  }

  return (
    <Modal open={open} onClose={onClose} title={`Запустить бурение: скважина №${well.well_number}`}>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 12 }}>
        <label>
          Организация бурения
          <select
            required
            value={orgId}
            onChange={(e) => {
              setOrgId(e.target.value)
              setRigId('')
            }}
          >
            <option value="">— выбрать —</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Буровой станок (необязательно)
          <select value={rigId} disabled={!orgId} onChange={(e) => setRigId(e.target.value)}>
            <option value="">— не указан —</option>
            {rigs
              .filter((r) => r.organization_id === orgId)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  № {r.rig_number}
                  {r.model ? ` (${r.model})` : ''}
                </option>
              ))}
          </select>
        </label>
        <label>
          Бригадир
          <select required value={foremanId} onChange={(e) => setForemanId(e.target.value)}>
            <option value="">— выбрать —</option>
            {pick.candidates.map((f) => (
              <option key={f.id} value={f.id}>
                {shortName(f.full_name)}
              </option>
            ))}
          </select>
          <AreaFilterHint pick={pick} what="мастера бурения" />
        </label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ flex: '1 1 160px' }}>
            Дата начала бурения
            <input required type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label style={{ flex: '1 1 160px' }}>
            План бурения, м/сутки
            <input type="number" step="any" placeholder="необязательно" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </label>
        </div>
        {error && <p className="text-error" style={{ margin: 0 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={saving}>
            {saving ? 'Запускаем…' : 'Запустить бурение'}
          </button>
          <button type="button" className="btn-outline" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </Modal>
  )
}
