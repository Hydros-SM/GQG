import { useCallback, useEffect, useState } from 'react'
import { isMasterProfile } from '../lib/masters'
import { ArrowRightLeft, LogIn } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { isManagement } from '../types/roles'
import Modal from './Modal'
import { formatRu, stayInfo } from '../lib/workerStay'
import type { Position, WorkerStay } from '../types/database'
import { shortName } from '../lib/shortName'

interface Handover {
  id: string
  from_name: string
  to_name: string
  tasks_count: number
  drafts_moved: number
  comment: string | null
  created_at: string
}

interface Candidate {
  id: string
  full_name: string
  position_name: string | null
  on_duty: boolean
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function DutyDot({ on }: { on: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        marginRight: 7,
        background: on ? 'var(--color-success)' : 'var(--color-danger)',
      }}
    />
  )
}

// Вахта и передача смены (миграция 0031). Мастер: «Сдать вахту» — все его
// активные скважины бурения и неотправленные черновики переходят выбранному
// сменщику, сам он уходит на межвахту (только чтение по сданным); «Заступить
// на вахту» — вернуться без передачи. Руководство видит, кто на вахте, и
// последние передачи.
export default function ShiftDutyCard() {
  const { profile } = useAuth()
  const isChief = profile?.role === 'party_chief'
  const isMgmt = isManagement(profile?.role)

  const [onDuty, setOnDuty] = useState(true)
  const [chiefs, setChiefs] = useState<{ id: string; full_name: string; on_duty: boolean }[]>([])
  const [handovers, setHandovers] = useState<Handover[]>([])
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [toId, setToId] = useState('')
  // По умолчанию сменщика выбирают среди мастеров; «Другие варианты» раскрывают
  // остальных ответственных (другие должности) — например, если мастера-сменщика нет.
  const [showOthers, setShowOthers] = useState(false)
  const [comment, setComment] = useState('')
  // Люди мастера при сдаче вахты: остаются (переходят к сменщику) или уезжают
  const [crew, setCrew] = useState<{ id: string; name: string; pos: string; stay: WorkerStay | null; keep: boolean }[]>([])
  const [summary, setSummary] = useState<{ tasks: number; drafts: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!profile) return
    if (isChief) {
      const { data } = await supabase.from('profiles').select('on_duty').eq('id', profile.id).single()
      if (data) setOnDuty(Boolean(data.on_duty))
    }
    if (isMgmt) {
      const [{ data }, { data: posRows }] = await Promise.all([
        supabase.from('profiles').select('id, full_name, on_duty, role, position_id').eq('role', 'party_chief').order('full_name'),
        supabase.from('positions').select('*'),
      ])
      setChiefs(
        ((data ?? []) as { id: string; full_name: string; on_duty: boolean; role: string; position_id: string | null }[]).filter((x) =>
          isMasterProfile(x, (posRows ?? []) as Position[]),
        ),
      )
    }
    const { data: hs } = await supabase
      .from('shift_handovers')
      .select('id, from_name, to_name, tasks_count, drafts_moved, comment, created_at')
      .order('created_at', { ascending: false })
      .limit(5)
    setHandovers((hs ?? []) as Handover[])
  }, [profile, isChief, isMgmt])

  useEffect(() => {
    reload()
  }, [reload])

  async function openHandover() {
    setOpen(true)
    setError(null)
    setDone(null)
    setToId('')
    setShowOthers(false)
    setComment('')
    const [{ data: cands }, tasksRes] = await Promise.all([
      supabase.rpc('list_shift_candidates'),
      supabase
        .from('drilling_tasks')
        .select('id')
        .eq('foreman_id', profile!.id)
        .in('status', ['in_progress', 'suspended']),
    ])
    setCandidates((cands ?? []) as Candidate[])
    const { data: myWorkers } = await supabase
      .from('workers')
      .select('id, full_name, position_id, archived_at')
      .eq('assigned_foreman_id', profile!.id)
      .is('archived_at', null)
      .order('full_name')
    const wIds = (myWorkers ?? []).map((w) => w.id as string)
    const [{ data: stayRows }, { data: posRows }] = await Promise.all([
      wIds.length > 0 ? supabase.from('worker_stays').select('*').in('worker_id', wIds).is('departed_on', null) : Promise.resolve({ data: [] }),
      supabase.from('positions').select('id, name'),
    ])
    const posName = new Map((posRows ?? []).map((p) => [p.id as string, p.name as string]))
    setCrew(
      (myWorkers ?? []).map((w) => ({
        id: w.id as string,
        name: shortName(w.full_name as string),
        pos: posName.get(w.position_id as string) ?? '',
        stay: ((stayRows ?? []) as WorkerStay[]).find((x) => x.worker_id === w.id) ?? null,
        keep: true,
      })),
    )
    const ids = (tasksRes.data ?? []).map((t) => t.id as string)
    let drafts = 0
    if (ids.length > 0) {
      const { data: reps } = await supabase
        .from('reports')
        .select('id, approval_status, edit_unlocked')
        .eq('author_id', profile!.id)
        .in('drilling_task_id', ids)
      drafts = (reps ?? []).filter((r) => r.approval_status === 'draft' || r.edit_unlocked).length
    }
    setSummary({ tasks: ids.length, drafts })
  }

  async function handleHandover() {
    if (!toId) {
      setError('Выберите сменщика.')
      return
    }
    setBusy(true)
    setError(null)
    const { data, error: rpcError } = await supabase.rpc('hand_over_shift', {
      p_to: toId,
      p_comment: comment.trim() || null,
      p_keep: crew.filter((c) => c.keep).map((c) => c.id),
      p_leave: crew.filter((c) => !c.keep).map((c) => c.id),
    })
    setBusy(false)
    if (rpcError) {
      setError(rpcError.message)
      return
    }
    const r = data as { tasks: number; drafts: number; kept?: number; left?: number }
    setDone('Вахта сдана: скважин ' + r.tasks + ', черновиков ' + r.drafts + (r.kept || r.left ? ', людей: остаются ' + (r.kept ?? 0) + ', уезжают ' + (r.left ?? 0) : '') + '. Вы на межвахте — доступ к сданным скважинам только для чтения.')
    await reload()
  }

  async function handleStart() {
    setBusy(true)
    const { error: rpcError } = await supabase.rpc('start_shift')
    setBusy(false)
    if (rpcError) setError(rpcError.message)
    await reload()
  }

  if (!isChief && !isMgmt) return null

  const isMaster = (c: Candidate) => /^мастер/i.test((c.position_name ?? '').trim())
  const masters = candidates.filter(isMaster)
  const others = candidates.filter((c) => !isMaster(c))
  const visibleCandidates = showOthers ? [...masters, ...others] : masters

  return (
    <div className="card" style={{ padding: '14px 16px', display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <ArrowRightLeft size={18} className="text-muted" />
        <span style={{ fontWeight: 700 }}>Вахта</span>
        {isChief && (
          <>
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>
              <DutyDot on={onDuty} />
              {onDuty ? 'Вы на вахте' : 'Вы на межвахте'}
            </span>
            <span style={{ marginLeft: 'auto' }}>
              {onDuty ? (
                <button type="button" className="btn-outline" onClick={openHandover} style={{ minHeight: 36 }}>
                  Сдать вахту
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={handleStart} style={{ minHeight: 36, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <LogIn size={15} /> Заступить на вахту
                </button>
              )}
            </span>
          </>
        )}
      </div>

      {isMgmt && chiefs.length > 0 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 14 }}>
          {chiefs.map((c) => (
            <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <DutyDot on={c.on_duty} />
              {shortName(c.full_name)}
              <span className="text-muted" style={{ marginLeft: 6, fontSize: 12 }}>{c.on_duty ? 'на вахте' : 'межвахта'}</span>
            </span>
          ))}
        </div>
      )}

      {!onDuty && isChief && (
        <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
          Сданные скважины и их сводки доступны только для чтения. Новые скважины назначает руководство или сдаёт ваш сменщик.
        </p>
      )}

      {handovers.length > 0 && (
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }} className="text-muted">
          {handovers.map((h) => (
            <span key={h.id}>
              <span className="num">{fmt(h.created_at)}</span> · {h.from_name} → {h.to_name} · скважин: {h.tasks_count}, черновиков: {h.drafts_moved}
              {h.comment ? ' · «' + h.comment + '»' : ''}
            </span>
          ))}
        </div>
      )}

      {error && !open && <p className="text-error" style={{ margin: 0 }}>{error}</p>}

      <Modal open={open} onClose={() => setOpen(false)} title="Сдать вахту">
        {done ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ margin: 0 }}>{done}</p>
            <button type="button" onClick={() => setOpen(false)}>Закрыть</button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <span>Сменщик</span>
              <div role="radiogroup" aria-label="Сменщик" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                <div
                  className="text-muted"
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr) 96px', gap: 8, padding: '8px 12px', fontSize: 12, background: 'var(--color-surface-muted)' }}
                >
                  <span>ФИО</span>
                  <span>Должность</span>
                  <span>Статус</span>
                </div>
                {masters.length === 0 && <div className="text-muted" style={{ padding: 12 }}>Мастеров для передачи нет — раскройте «Другие варианты».</div>}
                {visibleCandidates.map((c) => {
                  const selected = toId === c.id
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setToId(c.id)}
                      style={{
                        all: 'unset',
                        boxSizing: 'border-box',
                        width: '100%',
                        cursor: 'pointer',
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr) 96px',
                        gap: 8,
                        alignItems: 'center',
                        padding: '10px 12px',
                        borderTop: '1px solid var(--color-border)',
                        background: selected ? 'var(--color-primary-soft)' : 'transparent',
                        color: 'var(--color-text)',
                        fontSize: 14,
                      }}
                    >
                      <span style={{ fontWeight: selected ? 700 : 500 }}>{shortName(c.full_name)}</span>
                      <span className="text-muted" style={{ fontSize: 13 }}>{c.position_name ?? '—'}</span>
                      <span className={'badge ' + (c.on_duty ? 'badge-success' : 'badge-danger')} style={{ justifySelf: 'start' }}>
                        {c.on_duty ? 'На вахте' : 'Не на вахте'}
                      </span>
                    </button>
                  )
                })}
              </div>
              {others.length > 0 && (
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => {
                    if (showOthers && others.some((o) => o.id === toId)) setToId('')
                    setShowOthers((v) => !v)
                  }}
                  style={{ justifySelf: 'start', minHeight: 36, fontSize: 13 }}
                >
                  {showOthers ? 'Скрыть другие варианты' : 'Другие варианты (' + others.length + ')'}
                </button>
              )}
            </div>
            <label style={{ display: 'grid', gap: 4 }}>
              Комментарий сменщику (по желанию)
              <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            {crew.length > 0 && (
              <div style={{ display: 'grid', gap: 6 }}>
                <div className="eyebrow">Бригада · {crew.length} чел.</div>
                {crew.map((c) => {
                  const info = c.stay ? stayInfo(c.stay) : null
                  return (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '8px 10px', background: 'var(--color-surface-muted)' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                        <div className="text-muted" style={{ fontSize: 12 }}>
                          {c.pos}{c.stay ? ' · вахта до ' + formatRu(c.stay.planned_departure).slice(0, 5) : ''}
                          {info && info.overtime > 0 ? ' · +' + info.overtime + ' дн.' : ''}
                        </div>
                      </div>
                      <div className="org-orient" role="group">
                        <button type="button" className={c.keep ? 'is-on' : ''} onClick={() => setCrew((prev) => prev.map((x) => (x.id === c.id ? { ...x, keep: true } : x)))}>остаётся</button>
                        <button type="button" className={!c.keep ? 'is-on' : ''} onClick={() => setCrew((prev) => prev.map((x) => (x.id === c.id ? { ...x, keep: false } : x)))}>уезжает</button>
                      </div>
                    </div>
                  )
                })}
                <div className="text-muted" style={{ fontSize: 12 }}>Оставшиеся переходят к сменщику, уезжающим фиксируется выезд сегодняшней датой.</div>
              </div>
            )}
            {summary && (
              <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
                Будет передано: скважин бурения — <b>{summary.tasks}</b>, неотправленных черновиков и сводок на правке — <b>{summary.drafts}</b>.
                Вы уйдёте на межвахту, сданные скважины останутся у вас только для чтения.
              </p>
            )}
            {error && <p className="text-error" style={{ margin: 0 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" disabled={busy} onClick={handleHandover}>
                {busy ? 'Передаём…' : 'Сдать вахту'}
              </button>
              <button type="button" className="btn-outline" disabled={busy} onClick={() => setOpen(false)}>
                Отмена
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
