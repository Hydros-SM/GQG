import { useMemo, useState } from 'react'
import { isMasterProfile } from '../lib/masters'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import { createEmployeeWithLogin } from '../lib/grantAccess'
import { LEVEL_HINTS, LEVEL_LABELS, levelHasLogin, roleForLevel } from '../lib/accessLevels'
import { parsePersonValue } from '../lib/personRef'
import { shortName } from '../lib/shortName'
import Modal from './Modal'
import PersonSelect from './PersonSelect'
import type { DrillingOrganization, Position, Profile, Worker, WorkArea } from '../types/database'

type Step = 1 | 2 | 3 | 4 | 5

const AREA_OPTIONS: { value: Exclude<WorkArea, 'other'>; label: string }[] = [
  { value: 'drilling', label: 'Буровые работы' },
  { value: 'geology', label: 'Геологические работы' },
]

// Мастер «Добавить сотрудника» (09.10.2026): данные → профиль работ →
// должность → кому подчиняется → доступ (логин и пароль, только если
// уровень должности позволяет входить в платформу). Заменяет три прежние
// кнопки «Добавить человека / пользователя / работника».
export default function AddEmployeeWizard({
  open,
  onClose,
  positions,
  profiles,
  workers,
  organizations,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  positions: Position[]
  profiles: Profile[]
  workers: Worker[]
  organizations: DrillingOrganization[]
  onCreated: (created: { profile?: Profile; worker?: Worker }) => void
}) {
  const [step, setStep] = useState<Step>(1)
  const [fullName, setFullName] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [area, setArea] = useState<'drilling' | 'geology'>('drilling')
  const [positionId, setPositionId] = useState('')
  const [reportsTo, setReportsTo] = useState('')
  const [foremanId, setForemanId] = useState('')
  const [giveAccess, setGiveAccess] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const ownOrg = organizations.find((o) => o.is_own)
  const areaPositions = useMemo(
    () => positions.filter((p) => p.work_area === area || p.work_area === 'other').sort((a, b) => (a.level ?? 5) - (b.level ?? 5) || a.name.localeCompare(b.name)),
    [positions, area],
  )
  const position = positions.find((p) => p.id === positionId) ?? null
  const level = position?.level ?? 5
  const canLogin = levelHasLogin(level)
  const masters = profiles.filter((p) => isMasterProfile(p, positions))

  function reset() {
    setStep(1)
    setFullName('')
    setOrganizationId(ownOrg?.id ?? '')
    setArea('drilling')
    setPositionId('')
    setReportsTo('')
    setForemanId('')
    setGiveAccess(true)
    setEmail('')
    setPassword('')
    setError(null)
    setDone(null)
  }

  function close() {
    onClose()
    setTimeout(reset, 200)
  }

  const valid1 = fullName.trim().length > 2 && (organizationId || ownOrg?.id)
  const last: Step = 5

  function next() {
    setError(null)
    if (step === 3 && !positionId) return setError('Выберите должность')
    // Шаг «Доступ» нужен только должностям, которым разрешён вход.
    if (step === 4 && !canLogin) return void submit()
    setStep((step + 1) as Step)
  }

  async function submit() {
    setSaving(true)
    setError(null)
    const ref = parsePersonValue(reportsTo)
    const reportsToProfileId = ref?.kind === 'profile' ? ref.id : null
    const reportsToWorkerId = ref?.kind === 'worker' ? ref.id : null

    if (canLogin && giveAccess) {
      const role = roleForLevel(level, position?.name ?? '')
      if (!role) {
        setSaving(false)
        return setError('Для этой должности вход не предусмотрен')
      }
      const result = await createEmployeeWithLogin({
        fullName: fullName.trim(),
        email: email.trim(),
        password,
        role,
        positionId: positionId || null,
        reportsToProfileId,
        reportsToWorkerId,
      })
      setSaving(false)
      if ('error' in result) return setError(result.error)
      onCreated({ profile: result.profile })
      setDone('Сотрудник создан. Сообщите ему email и пароль лично — здесь они не сохраняются.')
      return
    }

    const { data, error: insertError } = await supabase
      .from('workers')
      .insert({
        full_name: fullName.trim(),
        organization_id: organizationId || ownOrg?.id,
        position_id: positionId || null,
        reports_to_profile_id: reportsToProfileId,
        reports_to_worker_id: reportsToWorkerId,
        assigned_foreman_id: foremanId || null,
      })
      .select()
      .single()
    setSaving(false)
    if (insertError || !data) return setError(insertError?.message ?? 'Не удалось добавить сотрудника')
    onCreated({ worker: data })
    setDone(canLogin ? 'Сотрудник добавлен без входа. Логин можно выдать позже в «Работниках».' : 'Сотрудник добавлен.')
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (step === last) void submit()
    else next()
  }

  const stepNames = ['Данные', 'Профиль работ', 'Должность', 'Подчинение', 'Доступ']
  const visibleSteps = canLogin || step < 4 ? stepNames : stepNames.slice(0, 4)

  return (
    <Modal open={open} onClose={close} title="Добавить сотрудника">
      {done ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <p className="text-success" style={{ margin: 0 }}>{done}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={reset}>Добавить ещё</button>
            <button type="button" className="btn-outline" onClick={close}>Закрыть</button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {visibleSteps.map((n, i) => (
              <span key={n} className={`badge ${i + 1 === step ? 'badge-primary' : i + 1 < step ? 'badge-success' : 'badge-neutral'}`}>
                {i + 1} {n}
              </span>
            ))}
          </div>

          {step === 1 && (
            <>
              <label>
                ФИО полностью
                <input required autoFocus value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Фамилия Имя Отчество" />
              </label>
              <label>
                Организация
                <select value={organizationId || ownOrg?.id || ''} onChange={(e) => setOrganizationId(e.target.value)}>
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}{o.is_own ? ' (своя)' : ''}</option>
                  ))}
                </select>
              </label>
            </>
          )}

          {step === 2 && (
            <div style={{ display: 'grid', gap: 8 }}>
              <span className="text-muted" style={{ fontSize: 13 }}>
                Профиль определяет, по каким работам сотрудник подаёт сводки.
              </span>
              {AREA_OPTIONS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  className={area === a.value ? '' : 'btn-outline'}
                  onClick={() => {
                    setArea(a.value)
                    setPositionId('')
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}

          {step === 3 && (
            <div style={{ display: 'grid', gap: 6 }}>
              {areaPositions.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={positionId === p.id ? '' : 'btn-outline'}
                  onClick={() => {
                    setPositionId(p.id)
                    setReportsTo('')
                  }}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8, textAlign: 'left' }}
                >
                  <span>{p.name}</span>
                  <span style={{ fontSize: 12, opacity: 0.85 }}>
                    ур. {p.level ?? 5} · {levelHasLogin(p.level ?? 5) ? 'с входом' : 'без входа'}
                  </span>
                </button>
              ))}
              {position && (
                <p className="text-muted" style={{ margin: 0, fontSize: 12 }}>
                  Уровень {level}, {LEVEL_LABELS[level]}: {LEVEL_HINTS[level]}.
                </p>
              )}
            </div>
          )}

          {step === 4 && (
            <>
              <label>
                К кому подчиняется
                <PersonSelect profiles={profiles} workers={workers} value={reportsTo} onChange={setReportsTo} positions={positions} forLevel={level} noneLabel="— ни к кому —" />
              </label>
              {!canLogin && (
                <label>
                  Бригада (мастер)
                  <select value={foremanId} onChange={(e) => setForemanId(e.target.value)}>
                    <option value="">— без бригады —</option>
                    {masters.map((m) => (
                      <option key={m.id} value={m.id}>{shortName(m.full_name)}</option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}

          {step === 5 && (
            <>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={giveAccess} onChange={(e) => setGiveAccess(e.target.checked)} style={{ width: 'auto' }} />
                Выдать вход в платформу сейчас
              </label>
              {giveAccess && (
                <>
                  <label>
                    Email
                    <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                  </label>
                  <label>
                    Временный пароль
                    <input type="text" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
                  </label>
                </>
              )}
            </>
          )}

          {error && <p className="text-error" style={{ margin: 0 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 8 }}>
            {step > 1 && (
              <button type="button" className="btn-outline" onClick={() => setStep((step - 1) as Step)}>Назад</button>
            )}
            <button
              type="submit"
              disabled={saving || (step === 1 && !valid1)}
              style={{ marginLeft: 'auto' }}
            >
              {saving ? 'Сохраняем…' : step === last || (step === 4 && !canLogin) ? 'Добавить' : 'Далее'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
