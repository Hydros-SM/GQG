import { useEffect, useState } from 'react'
import { isMasterProfile } from '../../lib/masters'
import { shortName } from '../../lib/shortName'
import type { FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Archive, ArchiveRestore, HardHat, Trash2, UserPlus, Pencil, KeyRound } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../context/AuthContext'
import { isManagement, ROLE_LABELS, ROLE_OPTIONS, type UserRole } from '../../types/roles'
import { riseIn } from '../../lib/motionVariants'
import { buildPersonNodes, collectDescendantKeys, parsePersonValue, reportsToValue, workerValue } from '../../lib/personRef'
import { grantAccessToWorker } from '../../lib/grantAccess'
import type { DrillingOrganization, Position, Profile, Worker } from '../../types/database'
import Modal from '../../components/Modal'
import { levelOfPosition } from '../../lib/accessLevels'
import PersonSelect from '../../components/PersonSelect'

// Карточка работника — своё состояние для удаления в два шага (тот же
// паттерн, что и у сводок/оргструктуры, см. отзыв 20.09.2026), чтобы не
// раздувать родительский компонент состоянием на каждую карточку.
function WorkerCard({
  worker,
  orgName,
  positionName,
  foremen,
  positions,
  allProfiles,
  allWorkers,
  hasAccount,
  onReassign,
  onArchiveToggle,
  onDeleted,
  onUpdated,
  onGranted,
}: {
  worker: Worker
  orgName: string
  positionName: string
  foremen: Profile[]
  positions: Position[]
  allProfiles: Profile[]
  allWorkers: Worker[]
  hasAccount: boolean
  onReassign: (workerId: string, foremanId: string) => void
  onArchiveToggle: (worker: Worker) => void
  onDeleted: (workerId: string) => void
  onUpdated: (worker: Worker) => void
  onGranted: (profile: Profile) => void
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [editOpen, setEditOpen] = useState(false)
  const [editPositionId, setEditPositionId] = useState(worker.position_id ?? '')
  const [editReportsTo, setEditReportsTo] = useState(
    reportsToValue(worker.reports_to_profile_id, worker.reports_to_worker_id),
  )
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  function openEdit() {
    setEditPositionId(worker.position_id ?? '')
    setEditReportsTo(reportsToValue(worker.reports_to_profile_id, worker.reports_to_worker_id))
    setEditError(null)
    setEditOpen(true)
  }

  // "Выдать доступ" (25.09.2026) — превращает эту запись в логин-аккаунт,
  // не заставляя перепечатывать ФИО в "Пользователях" (см. grantAccess.ts).
  const [grantOpen, setGrantOpen] = useState(false)
  const [grantEmail, setGrantEmail] = useState('')
  const [grantPassword, setGrantPassword] = useState('')
  const [grantRole, setGrantRole] = useState<UserRole>('party_chief')
  const [grantPositionId, setGrantPositionId] = useState(worker.position_id ?? '')
  const [grantReportsTo, setGrantReportsTo] = useState(
    reportsToValue(worker.reports_to_profile_id, worker.reports_to_worker_id),
  )
  const [granting, setGranting] = useState(false)
  const [grantError, setGrantError] = useState<string | null>(null)
  const [grantSuccess, setGrantSuccess] = useState(false)

  function openGrant() {
    setGrantEmail('')
    setGrantPassword('')
    setGrantRole('party_chief')
    setGrantPositionId(worker.position_id ?? '')
    setGrantReportsTo(reportsToValue(worker.reports_to_profile_id, worker.reports_to_worker_id))
    setGrantError(null)
    setGrantSuccess(false)
    setGrantOpen(true)
  }

  async function handleGrantSubmit(e: FormEvent) {
    e.preventDefault()
    setGranting(true)
    setGrantError(null)
    const reportsTo = parsePersonValue(grantReportsTo)
    const result = await grantAccessToWorker({
      worker,
      email: grantEmail,
      password: grantPassword,
      role: grantRole,
      positionId: grantPositionId || null,
      reportsToProfileId: reportsTo?.kind === 'profile' ? reportsTo.id : null,
      reportsToWorkerId: reportsTo?.kind === 'worker' ? reportsTo.id : null,
    })
    setGranting(false)
    if ('error' in result) {
      setGrantError(result.error)
      return
    }
    setGrantSuccess(true)
    onGranted(result.profile)
  }

  // Тот же приём, что в UsersList.tsx — не дать назначить руководителем
  // самого себя или своего же подчинённого (иерархия зациклится).
  const excludeKeys = collectDescendantKeys(workerValue(worker.id), buildPersonNodes(allProfiles, allWorkers))

  async function handleEditSave(e: FormEvent) {
    e.preventDefault()
    setEditSaving(true)
    setEditError(null)
    const reportsTo = parsePersonValue(editReportsTo)
    const { data, error: updateError } = await supabase
      .from('workers')
      .update({
        position_id: editPositionId || null,
        reports_to_profile_id: reportsTo?.kind === 'profile' ? reportsTo.id : null,
        reports_to_worker_id: reportsTo?.kind === 'worker' ? reportsTo.id : null,
      })
      .eq('id', worker.id)
      .select()
      .single()
    setEditSaving(false)
    if (updateError) {
      setEditError(updateError.message)
      return
    }
    onUpdated(data)
    setEditOpen(false)
  }

  async function handleDelete() {
    setDeleting(true)
    setDeleteError(null)
    const { data: deletedRows, error } = await supabase
      .from('workers')
      .delete()
      .eq('id', worker.id)
      .select('id')
    setDeleting(false)
    if (error) {
      setDeleteError(error.message)
      return
    }
    if (!deletedRows || deletedRows.length === 0) {
      setDeleteError('Не удалось удалить — попробуйте обновить страницу.')
      return
    }
    onDeleted(worker.id)
  }

  return (
    <motion.div
      className="card"
      {...riseIn(0, { duration: 0.25 })}
      style={{ padding: '10px 14px', display: 'grid', gap: 6, opacity: worker.archived_at ? 0.6 : 1 }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>
            {shortName(worker.full_name)}
            {worker.archived_at && (
              <span className="badge badge-neutral" style={{ marginLeft: 6, fontSize: 11 }}>
                архивирован
              </span>
            )}
          </span>
          <span className="text-muted" style={{ fontSize: 12 }}>
            {positionName} · {orgName}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          {!worker.archived_at && !hasAccount && (
            <button
              type="button"
              onClick={openGrant}
              title="Выдать доступ в приложение"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: 'var(--radius-full)',
                background: 'transparent',
                border: 'none',
                color: 'var(--color-text-muted)',
                padding: 0,
              }}
            >
              <KeyRound size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={openEdit}
            title="Редактировать должность и руководителя"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 'var(--radius-full)',
              background: 'transparent',
              border: 'none',
              color: 'var(--color-text-muted)',
              padding: 0,
            }}
          >
            <Pencil size={14} />
          </button>
        </div>
      </div>

      <Modal open={grantOpen} onClose={() => setGrantOpen(false)} title={`Выдать доступ: ${shortName(worker.full_name)}`}>
        {grantSuccess ? (
          <p style={{ margin: 0 }}>
            Учётная запись создана. Сообщите пользователю email и пароль отдельно (лично/мессенджером) — здесь они не
            сохраняются.
          </p>
        ) : (
          <form onSubmit={handleGrantSubmit} style={{ display: 'grid', gap: 12 }}>
            <label>
              Email
              <input type="email" required value={grantEmail} onChange={(e) => setGrantEmail(e.target.value)} />
            </label>
            <label>
              Временный пароль
              <input
                type="text"
                required
                minLength={6}
                value={grantPassword}
                onChange={(e) => setGrantPassword(e.target.value)}
              />
            </label>
            <label>
              Роль
              <select value={grantRole} onChange={(e) => setGrantRole(e.target.value as UserRole)}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Должность
              <select value={grantPositionId} onChange={(e) => setGrantPositionId(e.target.value)}>
                <option value="">— не указана —</option>
                {positions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Руководитель
              <PersonSelect
                profiles={allProfiles}
                workers={allWorkers}
                value={grantReportsTo}
                positions={positions}
                forLevel={levelOfPosition(positions, grantPositionId)}
                onChange={setGrantReportsTo}
                excludeKeys={new Set([workerValue(worker.id)])}
                noneLabel="— не назначен —"
              />
            </label>
            {grantError && <p className="text-error" style={{ margin: 0 }}>{grantError}</p>}
            <button type="submit" disabled={granting}>
              {granting ? 'Создаём…' : 'Выдать доступ'}
            </button>
          </form>
        )}
      </Modal>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={`Редактировать: ${shortName(worker.full_name)}`}>
        <form onSubmit={handleEditSave} style={{ display: 'grid', gap: 12 }}>
          <label>
            Должность
            <select value={editPositionId} onChange={(e) => setEditPositionId(e.target.value)}>
              <option value="">— не указана —</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Руководитель
            <PersonSelect
              profiles={allProfiles}
              workers={allWorkers}
              value={editReportsTo}
              positions={positions}
              forLevel={levelOfPosition(positions, editPositionId)}
              onChange={setEditReportsTo}
              excludeKeys={excludeKeys}
              noneLabel="— не назначен —"
            />
          </label>
          {editError && <p className="text-error" style={{ margin: 0 }}>{editError}</p>}
          <button type="submit" disabled={editSaving}>
            {editSaving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </form>
      </Modal>

      <select
        value={worker.assigned_foreman_id ?? ''}
        onChange={(e) => onReassign(worker.id, e.target.value)}
        style={{ fontSize: 13 }}
      >
        <option value="">— без бригадира —</option>
        {foremen.map((f) => (
          <option key={f.id} value={f.id}>
            {shortName(f.full_name)}
          </option>
        ))}
      </select>

      {!confirmingDelete ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="btn-outline"
            onClick={() => onArchiveToggle(worker)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, fontSize: 12, flex: 1 }}
          >
            {worker.archived_at ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            {worker.archived_at ? 'Вернуть из архива' : 'Архивировать'}
          </button>
          <button
            type="button"
            className="btn-outline"
            onClick={() => setConfirmingDelete(true)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, fontSize: 12, color: 'var(--color-danger)' }}
            title="Удалить безвозвратно"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {deleteError && <p className="text-error" style={{ fontSize: 12, margin: 0 }}>{deleteError}</p>}
          <p style={{ fontSize: 12, margin: 0, color: 'var(--color-text-muted)' }}>
            Удалить безвозвратно? Это уберёт работника и из истории распределений по заданиям, и из оргструктуры.
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn-danger"
              disabled={deleting}
              onClick={handleDelete}
              style={{ flex: 1, fontSize: 12 }}
            >
              {deleting ? 'Удаляем…' : 'Да, удалить'}
            </button>
            <button
              type="button"
              className="btn-outline"
              disabled={deleting}
              onClick={() => setConfirmingDelete(false)}
              style={{ flex: 1, fontSize: 12 }}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </motion.div>
  )
}

// Справочник состава буровых бригад (19.09.2026, по запросу заказчика) —
// отдельно от "Пользователей" (там только те, кто реально логинится).
// Здесь — ФИО/должность/организация + распределение по бригадирам:
// смена бригадира — обычный select на карточке, сохраняется сразу же
// (см. handleReassign), без отдельной формы правки.
//
// 23.09.2026 — добавлены архивирование (мягкое скрытие, не теряет
// историю распределений) и удаление (безвозвратное, см. миграцию 0014).
export default function WorkersSettings() {
  const { session, profile, loading: authLoading } = useAuth()

  const [workers, setWorkers] = useState<Worker[]>([])
  const [organizations, setOrganizations] = useState<DrillingOrganization[]>([])
  const [foremen, setForemen] = useState<Profile[]>([])
  const [allProfiles, setAllProfiles] = useState<Profile[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [loading, setLoading] = useState(true)

  const [addOpen, setAddOpen] = useState(false)
  const [fullName, setFullName] = useState('')
  const [positionId, setPositionId] = useState('')
  const [reportsTo, setReportsTo] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [foremanId, setForemanId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [filterOrgId, setFilterOrgId] = useState('')
  const [filterForemanId, setFilterForemanId] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  async function load() {
    setLoading(true)
    const [workersRes, orgsRes, foremenRes, profilesRes, positionsRes] = await Promise.all([
      supabase.from('workers').select('*').order('full_name'),
      supabase.from('drilling_organizations').select('*').order('name'),
      supabase.from('profiles').select('*').eq('role', 'party_chief').order('full_name'),
      supabase.from('profiles').select('*').neq('role', 'developer').order('full_name'),
      supabase.from('positions').select('*').order('name'),
    ])
    setWorkers(workersRes.data ?? [])
    setOrganizations(orgsRes.data ?? [])
    setForemen((foremenRes.data ?? []).filter((x) => isMasterProfile(x, positionsRes.data ?? [])))
    setAllProfiles(profilesRes.data ?? [])
    setPositions(positionsRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    if (session) load()
  }, [session])

  if (authLoading) return <p>Загрузка…</p>
  if (!session) return <Navigate to="/login" replace />
  if (!isManagement(profile?.role)) {
    return <p>Работников может добавлять и распределять только гендир/техдир.</p>
  }

  async function handleAddWorker(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    const reportsToParsed = parsePersonValue(reportsTo)
    const { data, error } = await supabase
      .from('workers')
      .insert({
        full_name: fullName.trim(),
        position_id: positionId || null,
        reports_to_profile_id: reportsToParsed?.kind === 'profile' ? reportsToParsed.id : null,
        reports_to_worker_id: reportsToParsed?.kind === 'worker' ? reportsToParsed.id : null,
        organization_id: organizationId,
        assigned_foreman_id: foremanId || null,
      })
      .select()
      .single()
    if (error) {
      setFormError(error.message)
      setSubmitting(false)
      return
    }
    setWorkers((prev) => [...prev, data].sort((a, b) => a.full_name.localeCompare(b.full_name)))
    setFullName('')
    setPositionId('')
    setReportsTo('')
    setOrganizationId('')
    setForemanId('')
    setSubmitting(false)
    setAddOpen(false)
  }

  async function handleReassign(workerId: string, newForemanId: string) {
    setWorkers((prev) =>
      prev.map((w) => (w.id === workerId ? { ...w, assigned_foreman_id: newForemanId || null } : w)),
    )
    await supabase
      .from('workers')
      .update({ assigned_foreman_id: newForemanId || null })
      .eq('id', workerId)
  }

  async function handleArchiveToggle(worker: Worker) {
    const nextArchivedAt = worker.archived_at ? null : new Date().toISOString()
    setWorkers((prev) =>
      prev.map((w) => (w.id === worker.id ? { ...w, archived_at: nextArchivedAt } : w)),
    )
    await supabase.from('workers').update({ archived_at: nextArchivedAt }).eq('id', worker.id)
  }

  function handleDeleted(workerId: string) {
    setWorkers((prev) => prev.filter((w) => w.id !== workerId))
  }

  function handleWorkerUpdated(updated: Worker) {
    setWorkers((prev) => prev.map((w) => (w.id === updated.id ? updated : w)))
  }

  // "Выдать доступ" (см. grantAccess.ts) уже архивировало и обнулило
  // должность исходной строки workers в базе — здесь просто синхронизируем
  // локальное состояние без перезагрузки страницы.
  function handleGranted(newProfile: Profile) {
    setAllProfiles((prev) => [...prev, newProfile].sort((a, b) => a.full_name.localeCompare(b.full_name)))
    if (newProfile.role === 'party_chief') {
      setForemen((prev) => [...prev, newProfile].sort((a, b) => a.full_name.localeCompare(b.full_name)))
    }
    if (newProfile.person_id) {
      setWorkers((prev) =>
        prev.map((w) => (w.id === newProfile.person_id ? { ...w, archived_at: new Date().toISOString(), position_id: null } : w)),
      )
    }
  }

  const orgName = (id: string) => organizations.find((o) => o.id === id)?.name ?? '—'
  const positionName = (id: string | null) => positions.find((p) => p.id === id)?.name ?? '— не указана —'

  const visibleWorkers = workers.filter((w) => {
    if (!showArchived && w.archived_at) return false
    if (filterOrgId && w.organization_id !== filterOrgId) return false
    if (filterForemanId === '__none__' && w.assigned_foreman_id) return false
    if (filterForemanId && filterForemanId !== '__none__' && w.assigned_foreman_id !== filterForemanId)
      return false
    return true
  })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 9, margin: 0 }}>
          <HardHat size={22} className="text-muted" /> Работники
        </h1>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
        >
          <UserPlus size={16} /> Добавить работника
        </button>
      </div>
      <p className="text-muted" style={{ marginBottom: 22 }}>
        Состав буровых бригад — без входа в приложение, только для учёта и распределения по бригадирам.
      </p>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Добавить работника">
      <form
        onSubmit={handleAddWorker}
        style={{ display: 'grid', gap: 12 }}
      >
        <label>
          ФИО
          <input required value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </label>
        <label>
          Должность
          <select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
            <option value="">— не указана —</option>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Руководитель
          <PersonSelect
            profiles={allProfiles}
            workers={workers}
            value={reportsTo}
            positions={positions}
            forLevel={levelOfPosition(positions, positionId)}
            onChange={setReportsTo}
            noneLabel="— не назначен —"
          />
        </label>
        <label>
          Организация
          <select required value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
            <option value="">— выбрать —</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Бригадир
          <select value={foremanId} onChange={(e) => setForemanId(e.target.value)}>
            <option value="">— пока не назначен —</option>
            {foremen.map((f) => (
              <option key={f.id} value={f.id}>
                {shortName(f.full_name)}
              </option>
            ))}
          </select>
        </label>

        {formError && <p className="text-error">{formError}</p>}

        <button
          type="submit"
          disabled={submitting}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}
        >
          {submitting ? <span className="spinner" style={{ marginRight: 0 }} /> : <UserPlus size={16} />}
          {submitting ? 'Добавляем…' : 'Добавить работника'}
        </button>
      </form>
      </Modal>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Список работников</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, margin: 0, fontWeight: 400, color: 'var(--color-text)' }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              style={{ width: 'auto' }}
            />
            показывать архивных
          </label>
          <select value={filterOrgId} onChange={(e) => setFilterOrgId(e.target.value)}>
            <option value="">Все организации</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select value={filterForemanId} onChange={(e) => setFilterForemanId(e.target.value)}>
            <option value="">Все бригадиры</option>
            <option value="__none__">— без бригадира —</option>
            {foremen.map((f) => (
              <option key={f.id} value={f.id}>
                {shortName(f.full_name)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 64, borderRadius: 'var(--radius-md)' }} />
          ))}
        </div>
      ) : visibleWorkers.length === 0 ? (
        <p className="text-muted" style={{ marginTop: 12 }}>
          Работников по этому фильтру нет.
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gap: 8,
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            marginTop: 12,
          }}
        >
          {visibleWorkers.map((w) => (
            <WorkerCard
              key={w.id}
              worker={w}
              orgName={orgName(w.organization_id)}
              positionName={positionName(w.position_id)}
              foremen={foremen}
              positions={positions}
              allProfiles={allProfiles}
              allWorkers={workers}
              hasAccount={allProfiles.some((p) => p.person_id === w.id)}
              onReassign={handleReassign}
              onArchiveToggle={handleArchiveToggle}
              onDeleted={handleDeleted}
              onUpdated={handleWorkerUpdated}
              onGranted={handleGranted}
            />
          ))}
        </div>
      )}
    </div>
  )
}
