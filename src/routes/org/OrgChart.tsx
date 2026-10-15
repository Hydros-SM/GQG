import { useEffect, useState } from 'react'
import { isMasterProfile } from '../../lib/masters'
import type { FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Network, UserCircle2, Plus, Search, ChevronRight, Users, ArrowRight, ArrowDown } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../context/AuthContext'
import { isManagement, ROLE_LABELS } from '../../types/roles'
import { shortName } from '../../lib/shortName'
import { levelOfPosition } from '../../lib/accessLevels'
import AddEmployeeWizard from '../../components/AddEmployeeWizard'
import type { DrillingOrganization, DrillingTask, Position, Profile, TaskWorkerAssignment, Worker, WorkerStay } from '../../types/database'
import {
  buildPersonNodes,
  collectDescendantKeys,
  parsePersonValue,
  profileValue,
  reportsToValue,
  workerValue,
  type PersonKind,
} from '../../lib/personRef'
import Modal from '../../components/Modal'
import PersonSelect from '../../components/PersonSelect'
import { useIsMobile } from '../../hooks/useMediaQuery'
import WorkerMovePanel from '../../components/WorkerMovePanel'
import { formatRu, stayInfo } from '../../lib/workerStay'

// Узел схемы — конкретный человек (profile или worker) с назначенной
// должностью, не абстрактный "слот" (см. CLAUDE.md, переход на
// person-centric модель 25.09.2026). Видимость в схеме ⟺ position_id
// задан у самого человека — редактируется в "Пользователях"/"Работниках"
// ИЛИ прямо здесь через ту же форму (два входа, одна правда).
interface ChartPerson {
  key: string
  kind: PersonKind
  id: string
  fullName: string
  positionId: string
  positionName: string
  reportsToKey: string | null
  role: Profile['role'] | null
  onDuty: boolean | null
  // «Бригада» работника (workers.assigned_foreman_id): к какому мастеру он приписан
  foremanId: string | null
}

const initials = (name: string) =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join('')
    .toUpperCase()


// Рабочая информация о человеке: скважины (для мастера) и смены бригады.
interface OrgCtx {
  selectedKey: string | null
  query: string
  crewOpen: Set<string>
  toggleCrew: (key: string) => void
  wellsByProfile: Map<string, DrillingTask[]>
  shiftOfWorker: Map<string, number>
  childrenByParent: Map<string | null, ChartPerson[]>
  // Бригады мастеров: состав и «кто числится в чьей бригаде» (такие люди отдельными узлами не рисуются)
  crewByMaster: Map<string, ChartPerson[]>
  crewMemberKeys: Set<string>
  // открытые вахты работников (для отметки переработки)
  stayByWorker: Map<string, WorkerStay>
  onSelect: (p: ChartPerson) => void
}

const matchesQuery = (p: ChartPerson, q: string) =>
  !q || (p.fullName + ' ' + p.positionName).toLowerCase().includes(q.toLowerCase())

// Состав бригады мастера: работники, приписанные к нему (assigned_foreman_id), а без
// приписки — подчинённые-исполнители прямо под ним.
function crewOf(p: ChartPerson, ctx: OrgCtx): ChartPerson[] {
  return ctx.crewByMaster.get(p.key) ?? []
}

// Дни переработки работника (0, если вахта в плане или не заведена)
function overtimeOf(c: ChartPerson, ctx: OrgCtx): number {
  const st = ctx.stayByWorker.get(c.id)
  return st ? stayInfo(st).overtime : 0
}

function DutyBadge({ onDuty }: { onDuty: boolean | null }) {
  if (onDuty == null) return null
  return (
    <span className="org-duty" data-on={onDuty ? '1' : '0'}>
      <i />
      {onDuty ? 'на вахте' : 'не на вахте'}
    </span>
  )
}

function HzNode({ person, ctx }: { person: ChartPerson; ctx: OrgCtx }) {
  const crew = crewOf(person, ctx)
  const kids = (ctx.childrenByParent.get(person.key) ?? []).filter((k) => !ctx.crewMemberKeys.has(k.key))
  const isChief = person.role === 'party_chief'
  const wells = person.kind === 'profile' ? (ctx.wellsByProfile.get(person.id) ?? []) : []
  const dim = ctx.query && !matchesQuery(person, ctx.query)
  const open = ctx.crewOpen.has(person.key)
  const shifts = [1, 2].map((n) => ({ n, list: crew.filter((c) => ctx.shiftOfWorker.get(c.id) === n) }))
  const noShift = crew.filter((c) => !ctx.shiftOfWorker.has(c.id))
  return (
    <li className="hz-item">
      <div className="hz-row">
        <div
          className={`hz-card${isChief ? ' is-chief' : ''}${ctx.selectedKey === person.key ? ' is-selected' : ''}${dim ? ' is-dim' : ''}`}
        >
          <button type="button" className="hz-card-main" onClick={() => ctx.onSelect(person)}>
            <span className="hz-av">{initials(person.fullName)}</span>
            <span className="hz-txt">
              <span className="hz-name">{shortName(person.fullName)}</span>
              <span className="hz-pos">{person.positionName}</span>
            </span>
          </button>
          {isChief && (
            <div className="hz-meta">
              <DutyBadge onDuty={person.onDuty} />
              {wells.length > 0 && <span className="hz-wells">скв.: {wells.map((w) => w.well_number).join(', ')}</span>}
            </div>
          )}
          {crew.length > 0 && (
            <>
              <button type="button" className="hz-crew-btn" onClick={() => ctx.toggleCrew(person.key)} aria-expanded={open}>
                <Users size={13} /> Бригада · {crew.length} чел.
                <ChevronRight size={13} style={{ marginLeft: 'auto', transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }} />
              </button>
              {open && (
                <div className="hz-crew">
                  {shifts.map(({ n, list }) =>
                    list.length > 0 ? (
                      <div key={n}>
                        <div className="hz-crew-h">Смена {n}</div>
                        {list.map((c) => (
                          <button key={c.key} type="button" className="hz-crew-p" onClick={() => ctx.onSelect(c)}>
                            {shortName(c.fullName)}{overtimeOf(c, ctx) > 0 && <b className="hz-ot"> +{overtimeOf(c, ctx)} дн.</b>} <span>{c.positionName}</span>
                          </button>
                        ))}
                      </div>
                    ) : null,
                  )}
                  {noShift.length > 0 && (
                    <div>
                      <div className="hz-crew-h">{shifts.some((x) => x.list.length > 0) ? 'Без смены' : 'Состав'}</div>
                      {noShift.map((c) => (
                        <button key={c.key} type="button" className="hz-crew-p" onClick={() => ctx.onSelect(c)}>
                          {shortName(c.fullName)}{overtimeOf(c, ctx) > 0 && <b className="hz-ot"> +{overtimeOf(c, ctx)} дн.</b>} <span>{c.positionName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {kids.length > 0 && (
          <ul className="hz-kids">
            {kids.map((k) => (
              <HzNode key={k.key} person={k} ctx={ctx} />
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

function MobileNode({ person, ctx, level, open, toggle }: { person: ChartPerson; ctx: OrgCtx; level: number; open: Set<string>; toggle: (k: string) => void }) {
  const kids = [
    ...(ctx.childrenByParent.get(person.key) ?? []).filter((k) => !ctx.crewMemberKeys.has(k.key)),
    ...(ctx.crewByMaster.get(person.key) ?? []),
  ]
  const isOpen = open.has(person.key)
  return (
    <>
      <div className={`mo-row${ctx.selectedKey === person.key ? ' is-selected' : ''}`} style={{ paddingLeft: 8 + level * 16 }}>
        <button type="button" className="mo-chev" onClick={() => kids.length > 0 && toggle(person.key)} aria-label={isOpen ? 'Свернуть' : 'Развернуть'} disabled={kids.length === 0}>
          {kids.length > 0 ? <ChevronRight size={16} style={{ transform: isOpen ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }} /> : null}
        </button>
        <button type="button" className="mo-main" onClick={() => ctx.onSelect(person)}>
          <span className="hz-av">{initials(person.fullName)}</span>
          <span className="hz-txt">
            <span className="hz-name">{shortName(person.fullName)}</span>
            <span className="hz-pos">{person.positionName}</span>
          </span>
          {overtimeOf(person, ctx) > 0 && <span className="hz-ot">+{overtimeOf(person, ctx)} дн.</span>}
          {person.role === 'party_chief' && person.onDuty != null && <i className="mo-dot" data-on={person.onDuty ? '1' : '0'} />}
          {kids.length > 0 && <span className="mo-count">{kids.length}</span>}
        </button>
      </div>
      {isOpen && kids.map((k) => <MobileNode key={k.key} person={k} ctx={ctx} level={level + 1} open={open} toggle={toggle} />)}
    </>
  )
}

// Организационная структура компании (22.09.2026, редизайн 25.09.2026 —
// переход от независимого дерева "вакантных должностей" к дереву,
// построенному напрямую из profiles/workers: должность и "руководитель" —
// поля самого человека, редактируются как здесь, так и в "Пользователях"/
// "Работниках" — правки синхронизированы в обе стороны, т.к. это одни и
// те же колонки БД. Прямое следствие отказа от вакансий (решение
// владельца 25.09.2026): человек без должности просто не появляется в
// схеме, пока её не назначат.
export default function OrgChart() {
  const { session, profile, loading: authLoading } = useAuth()

  const [profiles, setProfiles] = useState<Profile[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [organizations, setOrganizations] = useState<DrillingOrganization[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const isMobile = useIsMobile()
  const [query, setQuery] = useState('')
  const [helpOpen, setHelpOpen] = useState(false)
  // Ориентация схемы на ПК: слева направо или сверху вниз (запоминается в браузере)
  const [orient, setOrient] = useState<'h' | 'v'>(() => {
    try {
      return localStorage.getItem('gqg-org-orient') === 'v' ? 'v' : 'h'
    } catch {
      return 'h'
    }
  })
  const changeOrient = (o: 'h' | 'v') => {
    setOrient(o)
    try {
      localStorage.setItem('gqg-org-orient', o)
    } catch {
      // приватный режим — просто не запоминаем
    }
  }
  const [panelKey, setPanelKey] = useState<string | null>(null)
  const [crewOpen, setCrewOpen] = useState<Set<string>>(new Set())
  const [mobileOpen, setMobileOpen] = useState<Set<string>>(new Set())
  const [activeTasks, setActiveTasks] = useState<DrillingTask[]>([])
  const [assignments, setAssignments] = useState<TaskWorkerAssignment[]>([])
  const [stays, setStays] = useState<WorkerStay[]>([])
  const [view, setView] = useState<'chart' | 'stays'>('chart')
  const [staysFilter, setStaysFilter] = useState<'all' | 'overtime' | 'soon'>('all')

  const [selected, setSelected] = useState<ChartPerson | null>(null)
  const [editPositionId, setEditPositionId] = useState('')
  const [editReportsTo, setEditReportsTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // "+ Добавить человека" (25.09.2026, по запросу владельца — не все
  // существующие люди попадали в схему, и заводить их приходилось на
  // других экранах). Создание намеренно НЕ спрашивает должность/
  // руководителя сразу — новый человек появляется ниже, в разделе "Без
  // назначенной должности", и назначается туда отдельным кликом (тот же
  // openNode/handleSave, что и для узлов дерева).
  const [addPersonOpen, setAddPersonOpen] = useState(false)

  const canEdit = isManagement(profile?.role)

  async function load() {
    setLoading(true)
    const [profilesRes, workersRes, positionsRes, orgsRes] = await Promise.all([
      // .neq('role', 'developer') — доп. подстраховка сверх RLS: RLS и так
      // прячет профиль-разработчика от гендира/техдира, но если это окно
      // открыл сам разработчик, он увидел бы себя (id = auth.uid() всегда
      // проходит) и мог бы случайно назначить себя на видимую должность —
      // а он должен оставаться невидимым в схеме в любом случае.
      supabase.from('profiles').select('*').neq('role', 'developer').order('full_name'),
      supabase.from('workers').select('*').order('full_name'),
      supabase.from('positions').select('*').order('name'),
      supabase.from('drilling_organizations').select('*').order('name'),
    ])
    if (profilesRes.error) setError(profilesRes.error.message)
    setProfiles(profilesRes.data ?? [])
    setWorkers(workersRes.data ?? [])
    setPositions(positionsRes.data ?? [])
    setOrganizations(orgsRes.data ?? [])
    const { data: staysRows } = await supabase.from('worker_stays').select('*').is('departed_on', null)
    setStays((staysRows ?? []) as WorkerStay[])
    // Рабочий контекст: активные скважины мастеров и смены бригады (для карточек)
    const { data: tasks } = await supabase.from('drilling_tasks').select('*').in('status', ['in_progress', 'suspended'])
    const taskList = (tasks ?? []) as DrillingTask[]
    setActiveTasks(taskList)
    if (taskList.length > 0) {
      const { data: asg } = await supabase
        .from('task_worker_assignments')
        .select('*')
        .in('drilling_task_id', taskList.map((t) => t.id))
        .in('role', ['driller', 'assistant_driller'])
        .is('valid_to', null)
      setAssignments((asg ?? []) as TaskWorkerAssignment[])
    }
    setLoading(false)
  }

  useEffect(() => {
    if (session) load()
  }, [session])

  if (authLoading) return <p>Загрузка…</p>
  if (!session) return <Navigate to="/login" replace />

  const positionName = (id: string | null) => positions.find((p) => p.id === id)?.name ?? '—'

  const allPeople = buildPersonNodes(profiles, workers)

  // Работнику, которому «выдали доступ», остаётся старая (архивная) запись worker;
  // подчинённые могли остаться привязанными к ней — переводим ссылку на его профиль.
  const aliasMap = new Map<string, string>()
  for (const p of profiles) if (p.person_id) aliasMap.set(workerValue(p.person_id), profileValue(p.id))
  const alias = (k: string) => aliasMap.get(k) ?? k

  const chartPeople: ChartPerson[] = [
    ...profiles
      .filter((p) => p.position_id)
      .map((p) => ({
        key: profileValue(p.id),
        kind: 'profile' as const,
        id: p.id,
        fullName: p.full_name,
        positionId: p.position_id as string,
        positionName: positionName(p.position_id),
        reportsToKey: alias(reportsToValue(p.reports_to_profile_id, p.reports_to_worker_id)) || null,
        role: p.role,
        onDuty: p.on_duty ?? null,
        foremanId: null,
      })),
    ...workers
      // Архивный работник не должен висеть в схеме отдельным узлом — это
      // либо человек, ушедший из штата, либо (с 25.09.2026) работник,
      // которому "выдали доступ" (см. grantAccessToWorker): его запись
      // архивируется и должность обнуляется, но на случай, если должность
      // почему-то ещё не очищена, фильтруем и по archived_at тоже.
      .filter((w) => w.position_id && !w.archived_at)
      .map((w) => ({
        key: workerValue(w.id),
        kind: 'worker' as const,
        id: w.id,
        fullName: w.full_name,
        positionId: w.position_id as string,
        positionName: positionName(w.position_id),
        reportsToKey: alias(reportsToValue(w.reports_to_profile_id, w.reports_to_worker_id)) || null,
        role: null,
        onDuty: null,
        foremanId: w.assigned_foreman_id ?? null,
      })),
  ]

  // "Без назначенной должности" (25.09.2026) — люди, которые уже есть в
  // системе, но не показаны в дереве выше просто потому, что им никто не
  // назначил должность (частый случай: человека когда-то завели в
  // "Пользователях"/"Работниках" в обход оргструктуры). Та же форма
  // "должность + руководитель", что у узлов дерева — openNode ниже
  // принимает ChartPerson с пустым positionId одинаково хорошо.
  const unassignedPeople: ChartPerson[] = [
    ...profiles
      .filter((p) => !p.position_id)
      .map((p) => ({
        key: profileValue(p.id),
        kind: 'profile' as const,
        id: p.id,
        fullName: p.full_name,
        positionId: '',
        positionName: '',
        reportsToKey: alias(reportsToValue(p.reports_to_profile_id, p.reports_to_worker_id)) || null,
        role: p.role,
        onDuty: p.on_duty ?? null,
        foremanId: null,
      })),
    ...workers
      .filter((w) => !w.position_id && !w.archived_at)
      .map((w) => ({
        key: workerValue(w.id),
        kind: 'worker' as const,
        id: w.id,
        fullName: w.full_name,
        positionId: '',
        positionName: '',
        reportsToKey: alias(reportsToValue(w.reports_to_profile_id, w.reports_to_worker_id)) || null,
        role: null,
        onDuty: null,
        foremanId: w.assigned_foreman_id ?? null,
      })),
  ].sort((a, b) => a.fullName.localeCompare(b.fullName))

  const visibleKeys = new Set(chartPeople.map((p) => p.key))
  const childrenByParent = new Map<string | null, ChartPerson[]>()
  for (const p of chartPeople) {
    // Руководитель без своей должности не показан в схеме — считаем такого
    // человека корнем (его подчинённые всё равно должны быть видны).
    const parentKey = p.reportsToKey && visibleKeys.has(p.reportsToKey) ? p.reportsToKey : null
    const list = childrenByParent.get(parentKey) ?? []
    list.push(p)
    childrenByParent.set(parentKey, list)
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.fullName.localeCompare(b.fullName))
  }
  const crewByMaster = new Map<string, ChartPerson[]>()
  const crewMemberKeys = new Set<string>()
  const addCrew = (masterKey: string, w: ChartPerson) => {
    const list = crewByMaster.get(masterKey) ?? []
    list.push(w)
    crewByMaster.set(masterKey, list)
    crewMemberKeys.add(w.key)
  }
  for (const w of chartPeople) {
    if (w.kind !== 'worker') continue
    const brigadeKey = w.foremanId ? profileValue(w.foremanId) : null
    if (brigadeKey && visibleKeys.has(brigadeKey)) {
      addCrew(brigadeKey, w)
      continue
    }
    // без приписки к бригаде: исполнитель-лист прямо под ответственным
    const parent = w.reportsToKey && visibleKeys.has(w.reportsToKey) ? chartPeople.find((x) => x.key === w.reportsToKey) : undefined
    if (parent && parent.role === 'party_chief' && (childrenByParent.get(w.key) ?? []).length === 0) addCrew(parent.key, w)
  }
  const roots = (childrenByParent.get(null) ?? []).filter((r) => !crewMemberKeys.has(r.key))

  const wellsByProfile = new Map<string, DrillingTask[]>()
  for (const t of activeTasks) {
    if (!t.foreman_id) continue
    const list = wellsByProfile.get(t.foreman_id) ?? []
    list.push(t)
    wellsByProfile.set(t.foreman_id, list)
  }
  const shiftOfWorker = new Map<string, number>()
  for (const a of assignments) if (a.shift_number) shiftOfWorker.set(a.worker_id, a.shift_number)
  const ctx: OrgCtx = {
    selectedKey: panelKey,
    query,
    crewOpen,
    toggleCrew: (key) =>
      setCrewOpen((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    wellsByProfile,
    shiftOfWorker,
    childrenByParent,
    crewByMaster,
    crewMemberKeys,
    stayByWorker: new Map(stays.map((x) => [x.worker_id, x])),
    onSelect: (p) => setPanelKey(p.key),
  }
  const panelPerson = [...chartPeople, ...unassignedPeople].find((p) => p.key === panelKey) ?? null
  const personByKey = new Map([...chartPeople, ...unassignedPeople].map((p) => [p.key, p]))
  const toggleMobile = (k: string) =>
    setMobileOpen((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const queryHits = query ? chartPeople.filter((p) => matchesQuery(p, query)) : []

  // Вахты персонала: кто сколько на вахте, переработка, скоро выезд
  function renderStays() {
    const rows = stays
      .map((st) => {
        const w = workers.find((x) => x.id === st.worker_id)
        const info = stayInfo(st)
        const master = profiles.find((x) => x.id === w?.assigned_foreman_id)
        return { st, w, info, master }
      })
      .filter((r) => r.w && !r.w.archived_at && matchesQuery({ fullName: r.w.full_name, positionName: positionName(r.w.position_id) } as ChartPerson, query))
      .filter((r) => staysFilter === 'all' || (staysFilter === 'overtime' ? r.info.overtime > 0 : r.info.soon))
      .sort((a, b) => b.info.overtime - a.info.overtime || a.st.planned_departure.localeCompare(b.st.planned_departure))
    const nOver = stays.filter((x) => stayInfo(x).overtime > 0).length
    const nSoon = stays.filter((x) => stayInfo(x).soon).length
    return (
      <div className="org-stays">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {([['all', 'Все · ' + stays.length], ['overtime', 'Переработка · ' + nOver], ['soon', 'Заканчивается ≤3 дн. · ' + nSoon]] as const).map(([k, label]) => (
            <button key={k} type="button" className={staysFilter === k ? undefined : 'btn-outline'} onClick={() => setStaysFilter(k)} style={{ minHeight: 34, padding: '4px 12px', fontSize: 13 }}>{label}</button>
          ))}
        </div>
        {rows.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 13 }}>
            {stays.length === 0 ? 'Вахты ещё не заведены: откройте человека в схеме и нажмите «Начать вахту».' : 'Никого по этому фильтру.'}
          </p>
        ) : (
          <div className="org-stays-list">
            {rows.map(({ st, w, info, master }) => (
              <button key={st.id} type="button" className="org-stay-row" onClick={() => { setView('chart'); setPanelKey(workerValue(st.worker_id)) }}>
                <span className="org-stay-name">
                  <b>{shortName(w!.full_name)}</b>
                  <span className="text-muted">{positionName(w!.position_id)}{master ? ' · ' + shortName(master.full_name) : ''}</span>
                </span>
                <span className="org-stay-bar">
                  <span style={{ display: 'flex', height: 8, borderRadius: 4, background: 'var(--color-surface-muted)', overflow: 'hidden' }}>
                    <i style={{ width: info.plannedPct + '%', background: 'var(--color-primary)' }} />
                    <i style={{ width: info.overtimePct + '%', background: 'var(--color-warning)' }} />
                  </span>
                  <small className={info.overtime > 0 ? 'text-error' : 'text-muted'}>
                    {info.overtime > 0 ? '+' + info.overtime + ' дн. переработки' : 'осталось ' + info.remaining + ' дн.'}
                  </small>
                </span>
                <span className="num org-stay-date">{formatRu(st.planned_departure).slice(0, 5)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Карточка выбранного человека (общая для ПК-панели и мобильной шторки)
  function renderPanel(p: ChartPerson) {
    const boss = p.reportsToKey ? personByKey.get(p.reportsToKey) : undefined
    const subs = (childrenByParent.get(p.key) ?? []).filter((k) => !crewMemberKeys.has(k.key))
    const wells = p.kind === 'profile' ? (wellsByProfile.get(p.id) ?? []) : []
    const crew = crewOf(p, ctx)
    return (
      <div className="org-panel-body">
        <div className="org-panel-head">
          <span className="hz-av hz-av-lg">{initials(p.fullName)}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{shortName(p.fullName)}</div>
            <div className="text-muted" style={{ fontSize: 12 }}>{p.positionName || 'Должность не назначена'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {p.role && <span className="badge badge-neutral">{ROLE_LABELS[p.role]}</span>}
          {p.role === 'party_chief' && <DutyBadge onDuty={p.onDuty} />}
        </div>
        <div>
          <div className="eyebrow">Руководитель</div>
          {boss ? (
            <button type="button" className="org-link" onClick={() => setPanelKey(boss.key)}>
              {shortName(boss.fullName)} <span className="text-muted">· {boss.positionName}</span>
            </button>
          ) : (
            <div className="text-muted" style={{ fontSize: 13 }}>не назначен</div>
          )}
        </div>
        {subs.length > 0 && (
          <div>
            <div className="eyebrow">Подчинённые · {subs.length}</div>
            <div style={{ display: 'grid', gap: 3 }}>
              {subs.map((k) => (
                <button key={k.key} type="button" className="org-link" onClick={() => setPanelKey(k.key)}>
                  {shortName(k.fullName)} <span className="text-muted">· {k.positionName}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {wells.length > 0 && (
          <div>
            <div className="eyebrow">Активные скважины</div>
            <div style={{ display: 'grid', gap: 3 }}>
              {wells.map((w) => (
                <Link key={w.id} to={`/tasks/drilling/${w.id}/dashboard`} className="org-link">
                  №{w.well_number}
                </Link>
              ))}
            </div>
          </div>
        )}
        {crew.length > 0 && (
          <div>
            <div className="eyebrow">Бригада · {crew.length}</div>
            {[1, 2].map((n) => {
              const list = crew.filter((c) => shiftOfWorker.get(c.id) === n)
              return list.length > 0 ? (
                <div key={n} style={{ fontSize: 13, marginBottom: 4 }}>
                  <span className="text-muted">Смена {n}: </span>
                  {list.map((c) => `${shortName(c.fullName)} (${c.positionName})`).join(', ')}
                </div>
              ) : null
            })}
            {crew.filter((c) => !shiftOfWorker.has(c.id)).length > 0 && (
              <div style={{ fontSize: 13 }}>
                {crew.some((c) => shiftOfWorker.has(c.id)) && <span className="text-muted">Без смены: </span>}
                {crew.filter((c) => !shiftOfWorker.has(c.id)).map((c) => `${shortName(c.fullName)} (${c.positionName})`).join(', ')}
              </div>
            )}
          </div>
        )}
        {p.kind === 'worker' && (
          <WorkerMovePanel
            key={p.id}
            workerId={p.id}
            workerName={shortName(p.fullName)}
            foremanId={p.foremanId}
            canManage={canEdit || (!!profile && p.foremanId === profile.id)}
            masters={profiles.filter((x) => isMasterProfile(x, positions)).map((x) => ({ id: x.id, name: shortName(x.full_name), onDuty: x.on_duty ?? null }))}
            activeTasks={activeTasks}
            onChanged={load}
          />
        )}
        {canEdit && (
          <button type="button" className="btn-outline" onClick={() => { setPanelKey(null); openNode(p) }} style={{ width: '100%' }}>
            Изменить должность и руководителя
          </button>
        )}
      </div>
    )
  }

  function openNode(p: ChartPerson) {
    setSelected(p)
    setEditPositionId(p.positionId)
    setEditReportsTo(p.reportsToKey ?? '')
    setSaveError(null)
  }

  function closeNode() {
    setSelected(null)
  }

  // Тот же приём, что в Users/WorkersSettings — нельзя назначить
  // руководителем самого себя или своего же подчинённого (иерархия
  // зациклится). Считаем по ПОЛНОМУ списку людей (includes без должности),
  // т.к. цикл возможен и через невидимое сейчас звено.
  const excludeKeys = selected ? collectDescendantKeys(selected.key, allPeople) : new Set<string>()

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!selected) return
    setSaving(true)
    setSaveError(null)
    const reportsTo = parsePersonValue(editReportsTo)
    const table = selected.kind === 'profile' ? 'profiles' : 'workers'
    const { data, error: updateError } = await supabase
      .from(table)
      .update({
        position_id: editPositionId || null,
        reports_to_profile_id: reportsTo?.kind === 'profile' ? reportsTo.id : null,
        reports_to_worker_id: reportsTo?.kind === 'worker' ? reportsTo.id : null,
      })
      .eq('id', selected.id)
      .select()
      .single()
    setSaving(false)
    if (updateError) {
      setSaveError(updateError.message)
      return
    }
    if (selected.kind === 'profile') {
      setProfiles((prev) => prev.map((p) => (p.id === data.id ? data : p)))
    } else {
      setWorkers((prev) => prev.map((w) => (w.id === data.id ? data : w)))
    }
    setSelected(null)
  }

  // Убрать из схемы = очистить position_id — сам человек (и его
  // должность в "Пользователях"/"Работниках", если задать заново) не
  // удаляется, просто временно не отображается в дереве.
  async function handleRemoveFromChart() {
    if (!selected) return
    setSaving(true)
    setSaveError(null)
    const table = selected.kind === 'profile' ? 'profiles' : 'workers'
    const { data, error: updateError } = await supabase
      .from(table)
      .update({ position_id: null })
      .eq('id', selected.id)
      .select()
      .single()
    setSaving(false)
    if (updateError) {
      setSaveError(updateError.message)
      return
    }
    if (selected.kind === 'profile') {
      setProfiles((prev) => prev.map((p) => (p.id === data.id ? data : p)))
    } else {
      setWorkers((prev) => prev.map((w) => (w.id === data.id ? data : w)))
    }
    setSelected(null)
  }

  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '0 0 12px' }}>
        <Network size={22} className="text-muted" /> Оргструктура
        <button
          type="button"
          className="icon-btn-round"
          aria-label="Подсказка"
          title="Как устроена схема"
          onClick={() => setHelpOpen(true)}
          style={{ width: 28, height: 28, minWidth: 28, minHeight: 28, fontSize: 14, fontWeight: 700 }}
        >
          ?
        </button>
      </h1>

      {error && <p className="text-error">{error}</p>}

      <div className="org-views" role="tablist" aria-label="Вид">
        <button type="button" role="tab" aria-selected={view === 'chart'} className={view === 'chart' ? 'is-on' : ''} onClick={() => setView('chart')}>Схема</button>
        <button type="button" role="tab" aria-selected={view === 'stays'} className={view === 'stays' ? 'is-on' : ''} onClick={() => setView('stays')}>
          Вахты персонала
          {stays.some((x) => stayInfo(x).overtime > 0) && <span className="org-views-dot" />}
        </button>
      </div>

      <div className="org-toolbar">
        <div className="org-search">
          <Search size={15} className="text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по имени или должности" />
        </div>
        {!isMobile && (
          <div className="org-orient" role="group" aria-label="Ориентация схемы">
            <button type="button" className={orient === 'h' ? 'is-on' : ''} onClick={() => changeOrient('h')} title="Слева направо">
              <ArrowRight size={14} /> Горизонтально
            </button>
            <button type="button" className={orient === 'v' ? 'is-on' : ''} onClick={() => changeOrient('v')} title="Сверху вниз">
              <ArrowDown size={14} /> Вертикально
            </button>
          </div>
        )}
        {canEdit && (
          <div className="org-toolbar-actions">
            <button type="button" onClick={() => setAddPersonOpen(true)} className="org-tb-primary">
              <Plus size={15} /> Добавить сотрудника
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="skeleton" style={{ height: 300, borderRadius: 'var(--radius-md)' }} />
      ) : view === 'stays' ? (
        renderStays()
      ) : roots.length === 0 ? (
        <p className="text-muted">
          Пока никому не назначена должность — назначьте в разделе "Без назначенной должности" ниже.
        </p>
      ) : isMobile ? (
        <div className="mo-list">
          {query ? (
            queryHits.length === 0 ? (
              <p className="text-muted" style={{ padding: 12 }}>Никого не найдено.</p>
            ) : (
              queryHits.map((p) => (
                <MobileNode key={p.key} person={{ ...p }} ctx={{ ...ctx, childrenByParent: new Map(), crewByMaster: new Map() }} level={0} open={mobileOpen} toggle={toggleMobile} />
              ))
            )
          ) : (
            roots.map((r) => <MobileNode key={r.key} person={r} ctx={ctx} level={0} open={mobileOpen} toggle={toggleMobile} />)
          )}
        </div>
      ) : (
        <div className={`org-split${panelPerson ? ' has-panel' : ''}`}>
          <div className="hz-scroll">
            <ul className={`hz-tree${orient === 'v' ? ' is-vertical' : ''}`}>
              {roots.map((r) => (
                <HzNode key={r.key} person={r} ctx={ctx} />
              ))}
            </ul>
          </div>
          {panelPerson && (
            <aside className="org-panel">
              <button type="button" className="org-panel-close" onClick={() => setPanelKey(null)} aria-label="Закрыть карточку">×</button>
              {renderPanel(panelPerson)}
            </aside>
          )}
        </div>
      )}

      {isMobile && (
        <Modal open={panelPerson != null} onClose={() => setPanelKey(null)} title={shortName(panelPerson?.fullName)}>
          {panelPerson && renderPanel(panelPerson)}
        </Modal>
      )}

      {!loading && unassignedPeople.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 14, marginBottom: 6 }}>Без назначенной должности</h2>
          <p className="text-muted" style={{ fontSize: 13, marginTop: 0, marginBottom: 10 }}>
            Эти люди уже есть в системе, но не показаны в схеме выше — нажмите на карточку, чтобы назначить должность
            и руководителя.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {unassignedPeople.map((p) => (
              <button
                key={p.key}
                type="button"
                className="card card-interactive"
                onClick={() => openNode(p)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', color: 'var(--color-text)' }}
              >
                <UserCircle2 size={16} className="text-muted" />
                <span>
                  {shortName(p.fullName)}
                  {p.role && <span className="text-muted"> — {ROLE_LABELS[p.role]}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Modal
        open={selected != null}
        onClose={closeNode}
        title={selected ? (selected.positionId ? `${selected.positionName} — ${shortName(selected.fullName)}` : `Назначить должность: ${shortName(selected.fullName)}`) : ''}
      >
        {selected && (
          <div style={{ display: 'grid', gap: 18 }}>
            {canEdit ? (
              <form onSubmit={handleSave} style={{ display: 'grid', gap: 10 }}>
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
                    profiles={profiles}
                    workers={workers}
                    value={editReportsTo}
                    positions={positions}
                    forLevel={levelOfPosition(positions, editPositionId)}
                    onChange={setEditReportsTo}
                    excludeKeys={excludeKeys}
                    noneLabel="— не назначен —"
                  />
                </label>
                {saveError && <p className="text-error" style={{ margin: 0 }}>{saveError}</p>}
                <button type="submit" disabled={saving}>
                  {saving ? 'Сохраняем…' : 'Сохранить'}
                </button>
                {selected.positionId && (
                  <button
                    type="button"
                    className="btn-outline"
                    disabled={saving}
                    onClick={handleRemoveFromChart}
                    style={{ fontSize: 13, color: 'var(--color-danger)' }}
                  >
                    Убрать из схемы (не удаляет человека)
                  </button>
                )}
              </form>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <UserCircle2 size={18} className="text-muted" />
                {shortName(selected.fullName)}
                {selected.role && ` — ${ROLE_LABELS[selected.role]}`}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Как устроена схема">
        <div style={{ display: 'grid', gap: 10, fontSize: 14, lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>
            Схема строится из должностей и руководителей, заданных в <Link to="/users">пользователях</Link> и{' '}
            <Link to="/settings/workers">работниках</Link>: правки здесь и там синхронизированы.
          </p>
          <p style={{ margin: 0 }}>Оранжевая рамка — ответственный, он подаёт сводки в системе. Точка у мастера — вахта: зелёная на вахте, красная не на вахте.</p>
          <p style={{ margin: 0 }}>{isMobile ? 'Нажмите на человека, чтобы открыть карточку.' : 'Нажмите на карточку, чтобы открыть информацию справа.'} Человек без должности в схеме не отображается — найдите его в разделе «Без назначенной должности» ниже.</p>
        </div>
      </Modal>

      <AddEmployeeWizard
        open={addPersonOpen}
        onClose={() => setAddPersonOpen(false)}
        positions={positions}
        profiles={profiles}
        workers={workers}
        organizations={organizations}
        onCreated={({ profile: p, worker: w }) => {
          if (p) setProfiles((prev) => [...prev, p].sort((x, y) => x.full_name.localeCompare(y.full_name)))
          if (w) setWorkers((prev) => [...prev, w].sort((x, y) => x.full_name.localeCompare(y.full_name)))
        }}
      />
    </div>
  )
}
