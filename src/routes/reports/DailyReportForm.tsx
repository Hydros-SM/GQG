import { useEffect, useRef, useState } from 'react'
import { useWellHasCrew } from '../../hooks/useWellHasCrew'
import type { FormEvent } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ChevronLeft, MessageCircle, Check, Plus, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../context/AuthContext'
import { notifyReportsChanged } from '../../hooks/useReportCounts'
import { buildDrillingShiftMessage } from '../../lib/whatsappMessage'
import { round2 } from '../../lib/taskProgress'
import { DRILL_DIAMETERS, drillDiameterLabel, loadDiameterHistory, paintIntervals } from '../../lib/drillDiameters'
import { TASK_TYPE_REPORT_COLUMN, type TaskType } from '../../types/taskType'
import type {
  CoreDescriptionTask,
  CoreSawingTask,
  CostCategory,
  CostItem,
  DrillingTask,
  SamplingTask,
} from '../../types/database'
import Modal from '../../components/Modal'
import CostRowsEditor, {
  type CostRow,
} from '../../components/CostRowsEditor'

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

type AttachedTaskColumn = 'core_description_task_id' | 'core_sawing_task_id' | 'sampling_task_id'

interface SiblingIds {
  geo: string | null
  geotech: string | null
  sawing: string | null
  sampling: string | null
}

const EMPTY_SIBLINGS: SiblingIds = { geo: null, geotech: null, sawing: null, sampling: null }

// Строка-сиблинг может быть уже одобрена/на согласовании техдиром отдельно
// от сводки по бурению (согласование раздельное, см. комментарий ниже) —
// в этом случае RLS (reports_update_own_when_editable) её больше не даёт
// трогать. "Заблокированный" тип доп. работы показываем только для чтения
// и не пытаемся ни обновить, ни тем более вставить вторую строку рядом
// (это задвоило бы метраж/пробы после одобрения обеих строк).
interface SiblingLocked {
  geo: boolean
  geotech: boolean
  sawing: boolean
  sampling: boolean
}

const NOTHING_LOCKED: SiblingLocked = { geo: false, geotech: false, sawing: false, sampling: false }

// Посменная сводка — см. ТЗ v0.7, раздел 3-4. Суточная сводка отдельно
// НЕ заполняется, считается на фронтенде агрегацией посменных (позже,
// на экране просмотра — этот PR закрывает только ввод/правку).
// reportId в URL — режим редактирования (только для черновиков/
// разблокированных сводок, см. RLS reports_update_own_when_editable).
//
// Распиловка керна (core-sawing) и опробование (sampling) добавлены
// 17.09.2026 по разбору реального отчёта заказчику — см. миграцию 0007
// и CLAUDE.md. У распиловки смены называются "День"/"Ночь", а не "1-я"/
// "2-я" — те же shift_number 1/2, просто другая подпись. У опробования
// смен нет вообще (одна запись в день).
//
// 19.09.2026 — керн/распиловка/опробование можно прицепить прямо к
// заданию на бурение (DrillingTaskForm, "Дополнительные работы на этой
// скважине"). Когда таких прицепленных задач у скважины taskType='drilling'
// есть — эта форма показывает для них дополнительные поля и при сохранении
// пишет ОТДЕЛЬНЫЕ строки reports (по одной на каждую прицепленную задачу,
// см. saveAttachedReport) с ТЕМИ ЖЕ датой/сменой/часами/комментарием, что
// и у самой сводки по бурению. Согласование при этом остаётся раздельным
// по каждой строке (см. обсуждение 19.09.2026) — просто ввод объединён.
export default function DailyReportForm() {
  const { taskType, taskId, reportId } = useParams<{
    taskType: TaskType
    taskId: string
    reportId?: string
  }>()
  const isEditMode = Boolean(reportId)
  const hasCrew = useWellHasCrew(taskId, taskType === 'drilling')
  const { session, profile, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [drillingTask, setDrillingTask] = useState<DrillingTask | null>(null)
  const [drillingRigNumber, setDrillingRigNumber] = useState<string | null>(null)
  const [coreTask, setCoreTask] = useState<CoreDescriptionTask | null>(null)
  const [sawingTask, setSawingTask] = useState<CoreSawingTask | null>(null)
  const [samplingTask, setSamplingTask] = useState<SamplingTask | null>(null)
  // Скважина, связанная через drilling_task_id — нужна для подписи
  // (распиловка всегда "своя", опробование может быть "своим").
  const [linkedDrillingTask, setLinkedDrillingTask] = useState<DrillingTask | null>(null)
  const [loadingTask, setLoadingTask] = useState(true)

  // Работы, прицепленные к ЭТОМУ заданию на бурение (taskType==='drilling'
  // только) — см. комментарий выше.
  const [attachedGeoCore, setAttachedGeoCore] = useState<CoreDescriptionTask | null>(null)
  const [attachedGeotechCore, setAttachedGeotechCore] = useState<CoreDescriptionTask | null>(null)
  const [attachedSawing, setAttachedSawing] = useState<CoreSawingTask | null>(null)
  const [attachedSampling, setAttachedSampling] = useState<SamplingTask | null>(null)
  // id уже существующих строк reports по этим прицепленным задачам за ту
  // же дату/смену, что и текущая сводка — если найдены, submit их
  // ОБНОВЛЯЕТ, а не создаёт дубликат.
  const [siblingIds, setSiblingIds] = useState<SiblingIds>(EMPTY_SIBLINGS)
  const [siblingLocked, setSiblingLocked] = useState<SiblingLocked>(NOTHING_LOCKED)

  const [categories, setCategories] = useState<CostCategory[]>([])
  const [costItems, setCostItems] = useState<CostItem[]>([])
  // Затрат по умолчанию нет — строка появляется только по кнопке «+ статья затрат»
  const [costRows, setCostRows] = useState<CostRow[]>([])

  const [shiftNotes, setShiftNotes] = useState('')
  const [reportDate, setReportDate] = useState(todayIso())
  const shiftFromQuery = searchParams.get('shift')
  const [shiftNumber, setShiftNumber] = useState<'1' | '2' | ''>(
    shiftFromQuery === '2' ? '2' : '1',
  )
  const [hoursWorked, setHoursWorked] = useState('')
  // Метраж бурения (25.09.2026, по отзыву мастера участка — вернули
  // интервальный ввод "от"/"до", как у описания керна, вместо одного
  // числа за смену): "от" — забой на начало смены, автоподставляется из
  // накопленного забоя (см. knownMeters ниже) и НЕ редактируется; "до" —
  // забой на конец смены, вводится вручную. Сам delta (drillingTo -
  // drillingFrom) — то, что уходит в reports.drilling_meters, схема БД не
  // меняется, меняется только форма ввода.
  const [drillingFrom, setDrillingFrom] = useState('0')
  const [drillingTo, setDrillingTo] = useState('')
  // Проходка за смену вводится на шаге 1 вместо/вместе с «до»: «до» = «от» + проходка
  // считается сразу (03.10.2026). Храним строкой, чтобы не терять «5.» при наборе.
  const [metersInput, setMetersInput] = useState('')
  // Фактический диаметр бурения (06.10.2026): строки «от / проходка / до /
  // диаметр». «От» первой строки — забой на начало смены, у следующих — «до»
  // предыдущей. «До» и проходка ПОСЛЕДНЕЙ строки живут в drillingTo/metersInput
  // (это и есть забой на конец смены), у остальных — в to/m. По умолчанию —
  // диаметр последней сводки по заданию.
  const [diamSegs, setDiamSegs] = useState<{ code: string; to: string; m: string }[]>([{ code: '', to: '', m: '' }])
  // Правка старой сводки, где диаметр ещё не вносился — не требуем его задним числом.
  const [legacyNoDiam, setLegacyNoDiam] = useState(false)
  // Последний интервал бурения по прошлым сводкам — подсказка мастеру.
  // История диаметров бурения по прошлым сводкам: подряд идущие интервалы одного
  // диаметра склеены (PQ 0–10.7, HQ 10.7–45.9).
  // Расширение ствола (06.10.2026): участок уже пробуренного ствола, который
  // добурили другим диаметром. Метраж бурения не меняет, забой остаётся прежним.
  const [reamOn, setReamOn] = useState(false)
  const [diamHelpOpen, setDiamHelpOpen] = useState(false)
  const [reamRows, setReamRows] = useState<{ code: string; from: string; to: string }[]>([])
  const [diamHistory, setDiamHistory] = useState<{ code: string; from: number; to: number }[]>([])
  // Обсадка (06.10.2026): casingBase — текущее состояние по прошлым сводкам
  // (диаметр -> глубина, м), casingEdits — что мастер изменил в ЭТОЙ сводке.
  // Пустой список правок = обсадка не менялась, в сводку ничего не пишется.
  const [casingBase, setCasingBase] = useState<Record<string, number>>({})
  const [casingEdits, setCasingEdits] = useState<{ code: string; depth: string }[]>([])
  const [coreFrom, setCoreFrom] = useState('0')
  const [coreTo, setCoreTo] = useState('')
  const [photoFrom, setPhotoFrom] = useState('0')
  const [photoTo, setPhotoTo] = useState('')
  const [sawnMeters, setSawnMeters] = useState('')
  const [samplesTaken, setSamplesTaken] = useState('')
  const [samplesSubmitted, setSamplesSubmitted] = useState('')

  // Поля прицепленных геологической/геотехнической документации — отдельно
  // от coreFrom/coreTo/photoFrom/photoTo, т.к. на одной скважине могут быть
  // обе одновременно (см. миграцию 0007: это два разных задания).
  const [geoCoreFrom, setGeoCoreFrom] = useState('0')
  const [geoCoreTo, setGeoCoreTo] = useState('')
  const [geoPhotoFrom, setGeoPhotoFrom] = useState('0')
  const [geoPhotoTo, setGeoPhotoTo] = useState('')
  const [geotechCoreFrom, setGeotechCoreFrom] = useState('0')
  const [geotechCoreTo, setGeotechCoreTo] = useState('')
  const [geotechPhotoFrom, setGeotechPhotoFrom] = useState('0')
  const [geotechPhotoTo, setGeotechPhotoTo] = useState('')

  const [submitting, setSubmitting] = useState<'draft' | 'submit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  // React обновляет disabled на кнопке асинхронно — на быстрый повторный
  // тап/клик (типично на телефоне в поле) это не успевает среагировать,
  // и handleSubmit запускается дважды параллельно. Второй запуск после
  // того, как первый уже перевёл сводку в submitted (edit_unlocked снят),
  // не проходит RLS при апдейте и падает с "Cannot coerce the result to
  // a single JSON object" (0 строк). Синхронный ref — реальная защита от
  // повторного запуска, а не только визуальная.
  const submittingRef = useRef(false)

  // Забой (метраж, накопленный к текущей смене) для сообщения в WhatsApp —
  // сумма уже ПОДТВЕРЖДЁННЫХ смен по заданию, без учёта текущей формы
  // (см. отзыв 17.09.2026 — бригадиры дублируют сводку в рабочий чат).
  const [priorApprovedMeters, setPriorApprovedMeters] = useState(0)
  // Тот же забой, но включая ещё НЕ согласованные (submitted) смены —
  // подсказка возле поля "Метраж бурения за смену" (отзыв 20.09.2026,
  // "для понимания" — бригадиру нужно видеть актуальный забой сразу
  // после своей же отправки, не дожидаясь техдира). На WhatsApp-сообщение
  // не влияет — там принципиально только подтверждённые метры (см. выше).
  const [knownMeters, setKnownMeters] = useState(0)
  const [copied, setCopied] = useState(false)
  // Пошаговая форма для сводки по бурению (03.10.2026): 0 — смена и забой,
  // 1 — что сделано, 2 — затраты и отправка. Остальные виды сводок — одной
  // страницей, как раньше. Все поля остаются в DOM (скрыты), поэтому
  // введённые значения не теряются при переключении шагов.
  const [step, setStep] = useState<0 | 1 | 2>(0)
  // Текст для WhatsApp, собранный В МОМЕНТ успешной отправки (до сброса формы) —
  // чтобы мастер мог скопировать его уже после отправки (30.09.2026).
  const [sentMessage, setSentMessage] = useState<string | null>(null)
  // Дата и смена, для которых собран sentMessage: панель «отправлено» показывается
  // только пока форма стоит на них и ещё не заполняется заново, иначе при вводе
  // новой смены копировался бы текст ПРЕДЫДУЩЕЙ (03.10.2026).
  const [sentFor, setSentFor] = useState<{ date: string; shift: string } | null>(null)
  // Дата+смена последней успешно ОТПРАВЛЕННОЙ в этом сеансе сводки — пока
  // форма стоит на той же дате/смене, кнопки отправки заблокированы, чтобы
  // случайный повторный клик не создал вторую строку reports на то же
  // (дата, смена) (см. отзыв 20.09.2026). Меняется дата или смена —
  // разблокируется само, реактивно.
  const [lastSubmitted, setLastSubmitted] = useState<{ date: string; shift: string } | null>(null)

  const shiftsApply =
    taskType === 'drilling' || taskType === 'core-sawing'
      ? true
      : taskType === 'core-description'
        ? (coreTask?.shift_enabled ?? true)
        : false // sampling — одна запись в день, без смен

  useEffect(() => {
    if (!session || !taskId || !taskType) return

    async function findSiblingReport(column: AttachedTaskColumn, id: string, date: string, shift: number | null) {
      const query = supabase.from('reports').select('*').eq(column, id).eq('report_date', date)
      const { data } = await (shift == null ? query.is('shift_number', null) : query.eq('shift_number', shift)).maybeSingle()
      return data
    }

    // Подхватывает уже существующие строки reports по прицепленным работам
    // за ту же дату(+смену), что и текущая сводка по бурению — и заполняет
    // их поля, чтобы submit ОБНОВИЛ эти строки, а не создал дубликаты.
    // draft/edit_unlocked — то же условие, что и в RLS reports_update_own_
    // when_editable. Если сиблинг уже approved/submitted (согласуется
    // отдельно от бурения, см. шапку файла), его нельзя ни обновить (упадёт
    // с PGRST116, 0 строк), ни тем более вставить рядом вторую — задвоит
    // метраж/пробы, если обе строки потом одобрят.
    function isRowEditable(row: { approval_status: string; edit_unlocked: boolean }) {
      return row.approval_status === 'draft' || row.edit_unlocked
    }

    async function loadAttachedSiblings(
      date: string,
      shift: number | null,
      geo: CoreDescriptionTask | null,
      geotech: CoreDescriptionTask | null,
      saw: CoreSawingTask | null,
      sample: SamplingTask | null,
    ) {
      const ids: SiblingIds = { ...EMPTY_SIBLINGS }
      const locked: SiblingLocked = { ...NOTHING_LOCKED }

      if (geo) {
        const row = await findSiblingReport('core_description_task_id', geo.id, date, shift)
        if (row) {
          setGeoCoreFrom(row.core_description_interval_from != null ? String(row.core_description_interval_from) : '0')
          setGeoCoreTo(row.core_description_interval_to != null ? String(row.core_description_interval_to) : '')
          setGeoPhotoFrom(row.photofixation_interval_from != null ? String(row.photofixation_interval_from) : '0')
          setGeoPhotoTo(row.photofixation_interval_to != null ? String(row.photofixation_interval_to) : '')
          if (isRowEditable(row)) ids.geo = row.id
          else locked.geo = true
        }
      }
      if (geotech) {
        const row = await findSiblingReport('core_description_task_id', geotech.id, date, shift)
        if (row) {
          setGeotechCoreFrom(row.core_description_interval_from != null ? String(row.core_description_interval_from) : '0')
          setGeotechCoreTo(row.core_description_interval_to != null ? String(row.core_description_interval_to) : '')
          setGeotechPhotoFrom(row.photofixation_interval_from != null ? String(row.photofixation_interval_from) : '0')
          setGeotechPhotoTo(row.photofixation_interval_to != null ? String(row.photofixation_interval_to) : '')
          if (isRowEditable(row)) ids.geotech = row.id
          else locked.geotech = true
        }
      }
      if (saw) {
        const row = await findSiblingReport('core_sawing_task_id', saw.id, date, shift)
        if (row) {
          setSawnMeters(row.sawn_meters != null ? String(row.sawn_meters) : '')
          if (isRowEditable(row)) ids.sawing = row.id
          else locked.sawing = true
        }
      }
      if (sample) {
        const row = await findSiblingReport('sampling_task_id', sample.id, date, null)
        if (row) {
          setSamplesTaken(row.samples_taken != null ? String(row.samples_taken) : '')
          setSamplesSubmitted(row.samples_submitted != null ? String(row.samples_submitted) : '')
          if (isRowEditable(row)) ids.sampling = row.id
          else locked.sampling = true
        }
      }
      setSiblingIds(ids)
      setSiblingLocked(locked)
    }

    async function load() {
      setLoadingTask(true)

      const [catRes, itemsRes] = await Promise.all([
        supabase.from('cost_categories').select('*').order('name'),
        supabase.from('cost_items').select('*').order('name'),
      ])
      if (catRes.data) setCategories(catRes.data)
      if (itemsRes.data) setCostItems(itemsRes.data)

      let geo: CoreDescriptionTask | null = null
      let geotech: CoreDescriptionTask | null = null
      let saw: CoreSawingTask | null = null
      let sample: SamplingTask | null = null
      // Забой на начало смены (см. drillingFrom ниже) — считан в этой же
      // функции чуть позже; локальная переменная нужна, т.к. state
      // (knownMeters) обновится асинхронно и не будет виден ниже по коду
      // этого же вызова load().
      let knownSumAtLoad = 0

      if (taskType === 'drilling') {
        const { data } = await supabase
          .from('drilling_tasks')
          .select('*')
          .eq('id', taskId)
          .single()
        setDrillingTask(data)
        if (data?.drilling_rig_id) {
          const { data: rig } = await supabase
            .from('drilling_rigs')
            .select('rig_number')
            .eq('id', data.drilling_rig_id)
            .single()
          setDrillingRigNumber(rig?.rig_number ?? null)
        }

        const { data: taskReports } = await supabase
          .from('reports')
          .select('id, drilling_meters, approval_status')
          .eq('drilling_task_id', taskId)
        // Исключаем саму редактируемую сводку из суммы — иначе "от" при
        // правке включал бы её же метраж и был бы уже забоем НА КОНЕЦ этой
        // смены, а не на начало (см. пересчёт drillingTo ниже).
        const otherReports = (taskReports ?? []).filter((r) => r.id !== reportId)
        const approvedSum = round2(
          otherReports
            .filter((r) => r.approval_status === 'approved')
            .reduce((s, r) => s + (r.drilling_meters ?? 0), 0),
        )
        const knownSum = round2(
          otherReports
            .filter((r) => r.approval_status === 'approved' || r.approval_status === 'submitted')
            .reduce((s, r) => s + (r.drilling_meters ?? 0), 0),
        )
        setPriorApprovedMeters(approvedSum)
        setKnownMeters(knownSum)
        // "От" — забой на начало смены, автоподставляется и не редактируется
        // (см. отзыв 25.09.2026). Для новой сводки это и есть текущий забой;
        // при правке — тоже он, т.к. otherReports уже исключает саму сводку.
        setDrillingFrom(String(knownSum))
        knownSumAtLoad = knownSum

        // Диаметр по умолчанию — с которого закончили прошлую смену.
        const otherIds = otherReports.map((r) => r.id)
        if (otherIds.length > 0) {
          const { data: casRows } = await supabase
            .from('report_casings')
            .select('diameter_code, depth_to')
            .in('report_id', otherIds)
          const base: Record<string, number> = {}
          for (const c of casRows ?? []) base[c.diameter_code] = Math.max(base[c.diameter_code] ?? 0, c.depth_to)
          setCasingBase(base)
          const history = await loadDiameterHistory(supabase, taskId ?? '', reportId)
          setDiamHistory(history.intervals)
          const lastCode = history.lastCode
          if (lastCode) setDiamSegs([{ code: lastCode, to: '', m: '' }])
        }

        // Геологические работы (керн, распиловка, опробование) в сводку
        // мастера бурения больше не подмешиваются (03.10.2026): мастер заполняет
        // только бурение, а геологи вносят свою часть отдельно — на экране
        // «Геология» (GeologyDayReport). Поэтому прицепленные задачи здесь
        // намеренно не загружаются, и блоки в форме не показываются.
        geo = null
        geotech = null
        saw = null
        sample = null
        setAttachedGeoCore(geo)
        setAttachedGeotechCore(geotech)
        setAttachedSawing(saw)
        setAttachedSampling(sample)
      } else if (taskType === 'core-description') {
        const { data } = await supabase
          .from('core_description_tasks')
          .select('*')
          .eq('id', taskId)
          .single()
        setCoreTask(data)
      } else if (taskType === 'core-sawing') {
        const { data } = await supabase
          .from('core_sawing_tasks')
          .select('*')
          .eq('id', taskId)
          .single()
        setSawingTask(data)
        if (data?.drilling_task_id) {
          const { data: linked } = await supabase
            .from('drilling_tasks')
            .select('*')
            .eq('id', data.drilling_task_id)
            .single()
          setLinkedDrillingTask(linked)
        }
      } else if (taskType === 'sampling') {
        const { data } = await supabase
          .from('sampling_tasks')
          .select('*')
          .eq('id', taskId)
          .single()
        setSamplingTask(data)
        if (data?.drilling_task_id) {
          const { data: linked } = await supabase
            .from('drilling_tasks')
            .select('*')
            .eq('id', data.drilling_task_id)
            .single()
          setLinkedDrillingTask(linked)
        }
      }

      if (reportId) {
        // Режим редактирования — подгружаем существующую сводку и её затраты.
        const [reportRes, costsRes] = await Promise.all([
          supabase.from('reports').select('*').eq('id', reportId).single(),
          supabase
            .from('report_costs')
            .select('*')
            .eq('report_id', reportId),
        ])

        let loadedDate = reportDate
        let loadedShift: number | null = null

        if (reportRes.data) {
          const r = reportRes.data
          loadedDate = r.report_date
          loadedShift = r.shift_number
          setReportDate(r.report_date)
          setShiftNumber(r.shift_number ? (String(r.shift_number) as '1' | '2') : '')
          setHoursWorked(r.hours_worked != null ? String(r.hours_worked) : '')
          // "До" при правке — забой на начало смены (knownSumAtLoad, уже
          // считает без этой сводки) + её собственный метраж = забой на
          // конец этой смены, как он был при первой отправке.
          setDrillingTo(
            r.drilling_meters != null ? String(round2(knownSumAtLoad + r.drilling_meters)) : '',
          )
          setMetersInput(r.drilling_meters != null ? String(round2(r.drilling_meters)) : '')
          setCoreFrom(
            r.core_description_interval_from != null
              ? String(r.core_description_interval_from)
              : '0',
          )
          setCoreTo(
            r.core_description_interval_to != null
              ? String(r.core_description_interval_to)
              : '',
          )
          setPhotoFrom(
            r.photofixation_interval_from != null
              ? String(r.photofixation_interval_from)
              : '0',
          )
          setPhotoTo(
            r.photofixation_interval_to != null
              ? String(r.photofixation_interval_to)
              : '',
          )
          setSawnMeters(r.sawn_meters != null ? String(r.sawn_meters) : '')
          setSamplesTaken(r.samples_taken != null ? String(r.samples_taken) : '')
          setSamplesSubmitted(
            r.samples_submitted != null ? String(r.samples_submitted) : '',
          )
          setShiftNotes(r.shift_notes ?? '')
        }
        if (taskType === 'drilling') {
          const { data: diamRows } = await supabase
            .from('report_drill_diameters')
            .select('depth_from, depth_to, diameter_code, is_reaming')
            .eq('report_id', reportId)
            .order('depth_from', { ascending: true })
          const reamLoaded = (diamRows ?? []).filter((d) => d.is_reaming)
          if (reamLoaded.length > 0) {
            setReamOn(true)
            setReamRows(reamLoaded.map((d) => ({ code: d.diameter_code, from: String(round2(d.depth_from)), to: String(round2(d.depth_to)) })))
          }
          const normalRows = (diamRows ?? []).filter((d) => !d.is_reaming)
          if (normalRows.length > 0) {
            setDiamSegs(
              normalRows.map((d) => ({
                code: d.diameter_code,
                to: String(round2(d.depth_to)),
                m: String(round2(d.depth_to - d.depth_from)),
              })),
            )
            const lastRow = normalRows[normalRows.length - 1]
            setMetersInput(String(round2(lastRow.depth_to - lastRow.depth_from)))
          } else {
            setLegacyNoDiam(true)
          }
          const { data: casEdits } = await supabase
            .from('report_casings')
            .select('diameter_code, depth_to')
            .eq('report_id', reportId)
          setCasingEdits((casEdits ?? []).map((c) => ({ code: c.diameter_code, depth: String(round2(c.depth_to)) })))
        }
        if (costsRes.data && costsRes.data.length > 0) {
          setCostRows(
            costsRes.data.map((c) => ({
              cost_category_id:
                itemsRes.data?.find((it) => it.id === c.cost_item_id)?.category_id ?? '',
              cost_item_id: c.cost_item_id,
              quantity: c.quantity != null ? String(c.quantity) : '',
            })),
          )
        }

        if (taskType === 'drilling' && reportRes.data) {
          await loadAttachedSiblings(loadedDate, loadedShift, geo, geotech, saw, sample)
        }
      } else if (taskType === 'core-description') {
        // Новая сводка — автоподстановка "от" из последнего "до" по заданию.
        const { data: lastReport } = await supabase
          .from('reports')
          .select('core_description_interval_to, photofixation_interval_to')
          .eq('core_description_task_id', taskId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (lastReport) {
          setCoreFrom(String(lastReport.core_description_interval_to ?? 0))
          setPhotoFrom(String(lastReport.photofixation_interval_to ?? 0))
        }
      } else if (taskType === 'drilling') {
        // Новая сводка по бурению — автоподстановка "от" для прицепленных
        // задач керна (тот же приём, что и для самостоятельного описания
        // керна выше), плюс подхват уже поданных сиблингов на сегодня/эту
        // смену, если они как-то уже существуют.
        async function autofillCore(task: CoreDescriptionTask, setFrom: (v: string) => void, setPhotoFromFn: (v: string) => void) {
          const { data: lastReport } = await supabase
            .from('reports')
            .select('core_description_interval_to, photofixation_interval_to')
            .eq('core_description_task_id', task.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          if (lastReport) {
            setFrom(String(lastReport.core_description_interval_to ?? 0))
            setPhotoFromFn(String(lastReport.photofixation_interval_to ?? 0))
          }
        }
        if (geo) await autofillCore(geo, setGeoCoreFrom, setGeoPhotoFrom)
        if (geotech) await autofillCore(geotech, setGeotechCoreFrom, setGeotechPhotoFrom)

        const shift = shiftNumber ? Number(shiftNumber) : null
        await loadAttachedSiblings(reportDate, shift, geo, geotech, saw, sample)
      }

      setLoadingTask(false)
    }

    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, taskId, taskType, reportId])

  if (authLoading) return <p>Загрузка…</p>
  if (!session) return <Navigate to="/login" replace />
  if (!taskId || !taskType) return <p>Не указано задание.</p>
  if (profile && profile.role !== 'party_chief') {
    return <p>Сводки вносит только назначенный ответственный.</p>
  }
  // Пока на скважине не составлена бригада, сводку по бурению подать нельзя (14.10.2026)
  if (!isEditMode && taskType === 'drilling' && hasCrew === false) {
    return (
      <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
        <h2 style={{ margin: 0 }}>Сначала составьте бригаду</h2>
        <p className="text-muted" style={{ margin: 0 }}>
          На этой скважине ещё нет состава бригады. Составьте бригаду во вкладке «Моя бригада» и поставьте её на скважину, затем вернитесь к сводке.
        </p>
        <Link to="/my-crew"><button type="button">Перейти в «Мою бригаду»</button></Link>
      </div>
    )
  }
  // Закрытая скважина: новую сводку мастер уже не вносит (правка прежних — как раньше)
  if (!isEditMode && taskType === 'drilling' && drillingTask && (drillingTask.status === 'completed' || drillingTask.closed_reason)) {
    return (
      <div>
        <p>Скважина закрыта — новые сводки не вносятся.</p>
        <Link to={`/tasks/${taskType}/${taskId}/reports`}>К списку сводок</Link>
      </div>
    )
  }

  const wellLabel =
    taskType === 'drilling'
      ? `скважина №${drillingTask?.well_number ?? '…'}`
      : taskType === 'core-sawing'
        ? `скважина №${linkedDrillingTask?.well_number ?? '…'}`
        : taskType === 'sampling'
          ? samplingTask?.drilling_task_id
            ? `своя скважина №${linkedDrillingTask?.well_number ?? '…'}`
            : `скважина подрядчика №${samplingTask?.external_well_number ?? '…'}`
          : 'описание керна'

  // Опробование можно показать в объединённой форме, только если ЭТОТ
  // пользователь — тот же ответственный, что назначен на задание (иначе
  // RLS не даст записать строку от его имени, см. reports_insert_own).
  // Если ответственный за опробование — другая бригада, они вносят его
  // сводки по-старому, через самостоятельное задание "Опробование".
  const canFillAttachedSampling =
    attachedSampling != null && attachedSampling.assigned_party_chief_id === profile?.id

  async function handleSubmit(e: FormEvent, mode: 'draft' | 'submit') {
    e.preventDefault()
    if (!profile || !taskId || !taskType) return
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(mode)
    setError(null)
    setSuccessMsg(null)

    try {
      await doSubmit(mode)
    } finally {
      submittingRef.current = false
    }
  }

  async function saveAttachedReport(
    column: AttachedTaskColumn,
    attachedTaskId: string,
    siblingId: string | null,
    siteId: string,
    shift: number | null,
    metricFields: Record<string, number | null>,
  ) {
    if (!profile) throw new Error('Нет профиля')
    const base = {
      drilling_task_id: null as string | null,
      core_description_task_id: null as string | null,
      core_sawing_task_id: null as string | null,
      sampling_task_id: null as string | null,
      [column]: attachedTaskId,
      site_id: siteId,
      author_id: profile.id,
      report_date: reportDate,
      shift_number: shift,
      hours_worked: hoursWorked ? Number(hoursWorked) : null,
      shift_notes: shiftNotes.trim() || null,
      approval_status: 'draft' as const,
      submitted_at: null,
      ...metricFields,
    }
    return siblingId
      ? await supabase.from('reports').update(base).eq('id', siblingId).select().single()
      : await supabase.from('reports').insert(base).select().single()
  }

  // Границы строк диаметра (см. комментарий у diamSegs).
  const rowFrom = (i: number) => (i === 0 ? drillingFrom : diamSegs[i - 1].to)
  const rowTo = (i: number) => (i === diamSegs.length - 1 ? drillingTo : diamSegs[i].to)

  // Проверка диаметров бурения: у каждого интервала выбран размер, а «с метра»
  // смены диаметра лежит строго между забоем «от» и «до» и идёт по возрастанию.
  const diamIssue: string | null = (() => {
    if (taskType !== 'drilling') return null
    if (!legacyNoDiam && diamSegs.some((sg) => sg.code === '')) return 'Выберите диаметр бурения'
    for (let i = 0; i < diamSegs.length; i++) {
      const to = rowTo(i)
      if (to === '') {
        if (i < diamSegs.length - 1) return 'Укажите «до» для каждого диаметра'
        continue
      }
      if (Number(to) < Number(rowFrom(i) || 0)) return 'Диаметр ' + (i + 1) + ': «до» меньше «от»'
    }
    if (reamOn) {
      for (const r of reamRows) {
        if (r.code === '' || r.from === '' || r.to === '') return 'Расширение: выберите диаметр и укажите «с» и «до»'
        if (!(Number(r.to) > Number(r.from))) return 'Расширение: «до» должно быть больше «с»'
      }
    }
    const seen = new Set<string>()
    for (const c of casingEdits) {
      const v = Number(c.depth)
      if (c.code === '' || c.depth === '') return 'Обсадка: выберите диаметр и укажите глубину'
      if (seen.has(c.code)) return 'Обсадка: диаметр ' + c.code + ' указан дважды'
      seen.add(c.code)
      if (!(v > (casingBase[c.code] ?? 0))) {
        return 'Обсадка ' + c.code + ': глубина должна быть больше текущей (' + (casingBase[c.code] ?? 0) + ' м)'
      }
      if (drillingTo !== '' && v > Number(drillingTo)) return 'Обсадка ' + c.code + ': глубина больше забоя'
    }
    return null
  })()

  async function doSubmit(mode: 'draft' | 'submit') {
    if (!profile || !taskId || !taskType) return
    if (diamIssue) {
      setError(diamIssue)
      setSubmitting(null)
      return
    }
    const siteId =
      drillingTask?.site_id ?? coreTask?.site_id ?? sawingTask?.site_id ?? samplingTask?.site_id
    if (!siteId) {
      setError('Не удалось определить участок задания.')
      setSubmitting(null)
      return
    }

    // Затраты пишутся только пока сводка ЧЕРНОВИК (так требует RLS —
    // это намеренно, чтобы нельзя было незаметно поменять затраты в уже
    // отправленной сводке). Поэтому даже при "Отправить на согласование"
    // сначала сохраняем как draft, пишем затраты, и лишь ПОСЛЕ этого
    // отдельным запросом переключаем approval_status на submitted.
    const fields = {
      drilling_task_id: null as string | null,
      core_description_task_id: null as string | null,
      core_sawing_task_id: null as string | null,
      sampling_task_id: null as string | null,
      [TASK_TYPE_REPORT_COLUMN[taskType]]: taskId,
      site_id: siteId,
      author_id: profile.id,
      report_date: reportDate,
      shift_number: shiftsApply && shiftNumber ? Number(shiftNumber) : null,
      hours_worked: hoursWorked ? Number(hoursWorked) : null,
      drilling_meters:
        taskType === 'drilling' && drillingFrom !== '' && drillingTo !== ''
          ? round2(Number(drillingTo) - Number(drillingFrom))
          : null,
      core_description_interval_from:
        taskType === 'core-description' && coreTo ? Number(coreFrom) : null,
      core_description_interval_to:
        taskType === 'core-description' && coreTo ? Number(coreTo) : null,
      photofixation_interval_from:
        taskType === 'core-description' && photoTo ? Number(photoFrom) : null,
      photofixation_interval_to:
        taskType === 'core-description' && photoTo ? Number(photoTo) : null,
      sawn_meters: taskType === 'core-sawing' && sawnMeters ? Number(sawnMeters) : null,
      samples_taken: taskType === 'sampling' && samplesTaken ? Number(samplesTaken) : null,
      samples_submitted:
        taskType === 'sampling' && samplesSubmitted ? Number(samplesSubmitted) : null,
      shift_notes: shiftNotes.trim() || null,
      approval_status: 'draft' as const,
      submitted_at: null,
    }

    const { data: report, error: saveError } = isEditMode
      ? await supabase
          .from('reports')
          .update(fields)
          .eq('id', reportId)
          .select()
          .single()
      : await supabase.from('reports').insert(fields).select().single()

    if (saveError || !report) {
      // PGRST116 здесь означает, что UPDATE не задел ни одной строки — RLS
      // больше не считает сводку редактируемой (например, статус успели
      // поменять в другом месте, пока эта вкладка была открыта).
      setError(
        saveError?.code === 'PGRST116'
          ? 'Не удалось сохранить: сводка больше не редактируется (статус уже изменился). Обновите страницу и проверьте её текущее состояние.'
          : (saveError?.message ?? 'Не удалось сохранить сводку'),
      )
      setSubmitting(null)
      return
    }

    // Затраты: при редактировании проще всего снести старые строки
    // и записать текущее состояние формы заново, чем сверять построчно.
    // Затраты привязаны только к основной строке (бурение) — не дублируем
    // и не делим их между прицепленными работами той же смены.
    if (isEditMode) {
      const { error: deleteError } = await supabase
        .from('report_costs')
        .delete()
        .eq('report_id', report.id)
      if (deleteError) {
        setError(`Сводка сохранена, но не удалось обновить затраты: ${deleteError.message}`)
        setSubmitting(null)
        return
      }
    }

    const validCosts = costRows.filter((c) => c.cost_item_id)
    if (validCosts.length > 0) {
      const { error: costsError } = await supabase.from('report_costs').insert(
        validCosts.map((c) => ({
          report_id: report.id,
          cost_item_id: c.cost_item_id,
          quantity: c.quantity ? Number(c.quantity) : null,
        })),
      )
      if (costsError) {
        setError(
          `Сводка сохранена, но не удалось сохранить затраты: ${costsError.message}`,
        )
        setSubmitting(null)
        return
      }
    }

    // Фактический диаметр бурения (миграция 0027): тот же приём — снести
    // старые интервалы и записать текущие.
    if (taskType === 'drilling') {
      if (isEditMode) {
        await supabase.from('report_drill_diameters').delete().eq('report_id', report.id)
      }
      if (diamSegs[0].code !== '') {
        const { error: diamError } = await supabase.from('report_drill_diameters').insert(
          diamSegs
            .map((sg, i) => ({
              report_id: report.id,
              depth_from: round2(Number(rowFrom(i))),
              depth_to: round2(Number(rowTo(i))),
              diameter_code: sg.code,
            }))
            // интервал нулевой длины (перешли на другой диаметр ровно с
            // начала смены) не храним; последний оставляем — он задаёт
            // диаметр для следующей смены
            .filter((row, i, all) => row.depth_to > row.depth_from || i === all.length - 1),
        )
        if (diamError) {
          setError('Сводка сохранена, но не удалось сохранить диаметр бурения: ' + diamError.message)
          setSubmitting(null)
          return
        }
      }
    }

    // Расширение ствола (миграция 0029).
    if (taskType === 'drilling' && reamOn && reamRows.length > 0) {
      const { error: reamError } = await supabase.from('report_drill_diameters').insert(
        reamRows.map((r) => ({
          report_id: report.id,
          depth_from: round2(Number(r.from)),
          depth_to: round2(Number(r.to)),
          diameter_code: r.code,
          is_reaming: true,
        })),
      )
      if (reamError) {
        setError('Сводка сохранена, но не удалось сохранить расширение ствола: ' + reamError.message)
        setSubmitting(null)
        return
      }
    }

    // Обсадка (миграция 0028): пишем только то, что изменено в этой сводке.
    if (taskType === 'drilling') {
      if (isEditMode) {
        await supabase.from('report_casings').delete().eq('report_id', report.id)
      }
      if (casingEdits.length > 0) {
        const { error: casError } = await supabase.from('report_casings').insert(
          casingEdits.map((c) => ({ report_id: report.id, diameter_code: c.code, depth_to: round2(Number(c.depth)) })),
        )
        if (casError) {
          setError('Сводка сохранена, но не удалось сохранить обсадку: ' + casError.message)
          setSubmitting(null)
          return
        }
      }
    }

    // Прицепленные к скважине работы (керн/распиловка/опробование) —
    // отдельные строки reports с той же датой/сменой/часами/комментарием,
    // см. комментарий в шапке файла. Пишем только те, где реально введены
    // данные (или где уже есть строка-сиблинг — тогда обновляем её, даже
    // если поля очистили до пустых).
    const newSiblingIds: SiblingIds = { ...siblingIds }
    const attachedShift = shiftNumber ? Number(shiftNumber) : null

    if (taskType === 'drilling') {
      if (attachedGeoCore && !siblingLocked.geo && (siblingIds.geo || geoCoreTo || geoPhotoTo)) {
        const res = await saveAttachedReport(
          'core_description_task_id',
          attachedGeoCore.id,
          siblingIds.geo,
          siteId,
          attachedShift,
          {
            core_description_interval_from: geoCoreTo ? Number(geoCoreFrom) : null,
            core_description_interval_to: geoCoreTo ? Number(geoCoreTo) : null,
            photofixation_interval_from: geoPhotoTo ? Number(geoPhotoFrom) : null,
            photofixation_interval_to: geoPhotoTo ? Number(geoPhotoTo) : null,
          },
        )
        if (res.error || !res.data) {
          setError(`Сводка по бурению сохранена, но не удалось сохранить керн (геологическая): ${res.error?.message ?? '—'}`)
          setSubmitting(null)
          return
        }
        newSiblingIds.geo = res.data.id
      }

      if (attachedGeotechCore && !siblingLocked.geotech && (siblingIds.geotech || geotechCoreTo || geotechPhotoTo)) {
        const res = await saveAttachedReport(
          'core_description_task_id',
          attachedGeotechCore.id,
          siblingIds.geotech,
          siteId,
          attachedShift,
          {
            core_description_interval_from: geotechCoreTo ? Number(geotechCoreFrom) : null,
            core_description_interval_to: geotechCoreTo ? Number(geotechCoreTo) : null,
            photofixation_interval_from: geotechPhotoTo ? Number(geotechPhotoFrom) : null,
            photofixation_interval_to: geotechPhotoTo ? Number(geotechPhotoTo) : null,
          },
        )
        if (res.error || !res.data) {
          setError(`Сводка по бурению сохранена, но не удалось сохранить керн (геотехническая): ${res.error?.message ?? '—'}`)
          setSubmitting(null)
          return
        }
        newSiblingIds.geotech = res.data.id
      }

      if (attachedSawing && !siblingLocked.sawing && (siblingIds.sawing || sawnMeters)) {
        const res = await saveAttachedReport(
          'core_sawing_task_id',
          attachedSawing.id,
          siblingIds.sawing,
          siteId,
          attachedShift,
          { sawn_meters: sawnMeters ? Number(sawnMeters) : null },
        )
        if (res.error || !res.data) {
          setError(`Сводка по бурению сохранена, но не удалось сохранить распиловку: ${res.error?.message ?? '—'}`)
          setSubmitting(null)
          return
        }
        newSiblingIds.sawing = res.data.id
      }

      if (
        canFillAttachedSampling &&
        attachedSampling &&
        !siblingLocked.sampling &&
        (siblingIds.sampling || samplesTaken || samplesSubmitted)
      ) {
        const res = await saveAttachedReport(
          'sampling_task_id',
          attachedSampling.id,
          siblingIds.sampling,
          siteId,
          null,
          {
            samples_taken: samplesTaken ? Number(samplesTaken) : null,
            samples_submitted: samplesSubmitted ? Number(samplesSubmitted) : null,
          },
        )
        if (res.error || !res.data) {
          setError(`Сводка по бурению сохранена, но не удалось сохранить опробование: ${res.error?.message ?? '—'}`)
          setSubmitting(null)
          return
        }
        newSiblingIds.sampling = res.data.id
      }

      setSiblingIds(newSiblingIds)
    }

    if (mode === 'submit') {
      const now = new Date().toISOString()
      const idsToSubmit = [
        report.id,
        ...(taskType === 'drilling'
          ? [newSiblingIds.geo, newSiblingIds.geotech, newSiblingIds.sawing, newSiblingIds.sampling]
          : []),
      ].filter((id): id is string => Boolean(id))

      const { error: submitError } = await supabase
        .from('reports')
        .update({
          approval_status: 'submitted',
          submitted_at: now,
          // Сброс следов прошлого отклонения при повторной отправке —
          // иначе старый комментарий и разблокировка "зависли" бы навсегда.
          edit_unlocked: false,
          review_comment: null,
        })
        .in('id', idsToSubmit)
      if (submitError) {
        setError(
          `Сводка и затраты сохранены как черновик, но не удалось отправить на согласование: ${submitError.message}`,
        )
        setSubmitting(null)
        return
      }
    }

    setSubmitting(null)
    if (mode === 'submit') {
      // Правка (пересдача отклонённой/уже отправленной сводки) — уходим
      // со страницы, как и при сохранении черновика: этот конкретный
      // reportId только что перестал быть редактируемым, оставаться на
      // форме незачем и рискованно (повторный клик упёрся бы в RLS,
      // см. PGRST116 выше). Новая сводка (не правка) — остаёмся и сразу
      // готовим форму под следующую смену (см. отзыв 20.09.2026).
      if (isEditMode) {
        navigate(`/tasks/${taskType}/${taskId}/reports`)
        return
      }
      if (taskType === 'drilling' && drillingFrom !== '' && drillingTo !== '') {
        setKnownMeters((prev) => round2(prev + (Number(drillingTo) - Number(drillingFrom))))
        // Забой на конец только что отправленной смены становится забоем
        // на начало следующей — та же логика, что и у coreFrom/photoFrom.
        setDrillingFrom(drillingTo)
      }
      if (taskType === 'drilling') {
        setSentMessage(buildWhatsAppMessage())
        setSentFor({ date: reportDate, shift: shiftNumber })
      }
      notifyReportsChanged()
      setLastSubmitted({ date: reportDate, shift: shiftNumber })
      setStep(2)
      setSuccessMsg('Сводка отправлена на согласование. Можно сразу заполнять следующую смену.')
      setHoursWorked('')
      setDrillingTo('')
      setMetersInput('')
      setDiamSegs((prev) => [{ code: prev[prev.length - 1].code, to: '', m: '' }])
      setCasingBase((prev) => {
        const next = { ...prev }
        for (const c of casingEdits) next[c.code] = Math.max(next[c.code] ?? 0, Number(c.depth))
        return next
      })
      setCasingEdits([])
      setDiamHistory((prev) =>
        paintIntervals([
          ...prev,
          ...diamSegs
            .map((sg, i) => ({ code: sg.code, from: Number(rowFrom(i) || 0), to: Number(rowTo(i) || 0) }))
            .filter((d) => d.code !== ''),
          ...(reamOn ? reamRows.map((r) => ({ code: r.code, from: Number(r.from), to: Number(r.to) })) : []),
        ]),
      )
      setReamOn(false)
      setReamRows([])
      setCoreFrom('0')
      setCoreTo('')
      setPhotoFrom('0')
      setPhotoTo('')
      setSawnMeters('')
      setSamplesTaken('')
      setSamplesSubmitted('')
      setShiftNotes('')
      setCostRows([])
      setGeoCoreFrom('0')
      setGeoCoreTo('')
      setGeoPhotoFrom('0')
      setGeoPhotoTo('')
      setGeotechCoreFrom('0')
      setGeotechCoreTo('')
      setGeotechPhotoFrom('0')
      setGeotechPhotoTo('')
      // Сиблинги (прицепленные работы) относились к ТОЛЬКО ЧТО отправленной
      // дате/смене — если бригадир сейчас поменяет дату/смену и продолжит
      // заполнять форму, это должны быть НОВЫЕ строки, а не обновление
      // уже отправленных. Без сброса второй submit тихо перезаписал бы их.
      setSiblingIds(EMPTY_SIBLINGS)
      setSiblingLocked(NOTHING_LOCKED)
    } else {
      navigate(`/tasks/${taskType}/${taskId}/reports`)
      return
    }
  }

  function buildWhatsAppMessage() {
    const meters = drillingFrom !== '' && drillingTo !== '' ? round2(Number(drillingTo) - Number(drillingFrom)) : 0
    const coreDescriptions = []
    if (attachedGeoCore && geoCoreTo) {
      coreDescriptions.push({
        label: 'геологическая',
        from: Number(geoCoreFrom),
        to: Number(geoCoreTo),
        photoFrom: geoPhotoTo ? Number(geoPhotoFrom) : null,
        photoTo: geoPhotoTo ? Number(geoPhotoTo) : null,
      })
    }
    if (attachedGeotechCore && geotechCoreTo) {
      coreDescriptions.push({
        label: 'геотехническая',
        from: Number(geotechCoreFrom),
        to: Number(geotechCoreTo),
        photoFrom: geotechPhotoTo ? Number(geotechPhotoFrom) : null,
        photoTo: geotechPhotoTo ? Number(geotechPhotoTo) : null,
      })
    }
    const message = buildDrillingShiftMessage({
      wellNumber: drillingTask?.well_number ?? '?',
      rigNumber: drillingRigNumber,
      reportDate,
      shiftNumber: shiftsApply && shiftNumber ? Number(shiftNumber) : null,
      meters,
      // Глубина = забой «до» из формы. Он уже учитывает и согласованные, и ещё
      // не согласованные смены (см. drillingFrom/knownMeters), поэтому сообщение
      // не зависит от того, приняты ли предыдущие сводки (03.10.2026).
      bottomHole: drillingTo !== '' ? round2(Number(drillingTo)) : round2(Number(drillingFrom || 0)),
      shiftNotes,
      drillIntervals: diamSegs
        .map((sg, i) => ({ code: sg.code, from: round2(Number(rowFrom(i) || 0)), to: round2(Number(rowTo(i) || 0)) }))
        .filter((d, i, all) => d.code !== '' && (d.to > d.from || i === all.length - 1)),
      reamings: reamOn
        ? reamRows.filter((r) => r.code && r.from !== '' && r.to !== '').map((r) => ({ code: r.code, from: round2(Number(r.from)), to: round2(Number(r.to)) }))
        : [],
      casings: (() => {
        const merged: Record<string, number> = { ...casingBase }
        for (const c of casingEdits) {
          if (c.code && c.depth !== '') merged[c.code] = Math.max(merged[c.code] ?? 0, Number(c.depth))
        }
        return Object.entries(merged).map(([code, depth]) => ({ code, depth: round2(depth) }))
      })(),
      coreDescriptions,
      sawnMeters: attachedSawing && sawnMeters ? Number(sawnMeters) : null,
      samplesTaken: canFillAttachedSampling && samplesTaken ? Number(samplesTaken) : null,
      samplesSubmitted: canFillAttachedSampling && samplesSubmitted ? Number(samplesSubmitted) : null,
    })
    return message
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Не удалось скопировать — скопируйте текст вручную.')
    }
  }

  const showSent =
    Boolean(successMsg) &&
    sentFor !== null &&
    sentFor.date === reportDate &&
    sentFor.shift === shiftNumber &&
    drillingTo === ''

  // Скрывает шаги, кроме текущего, только для сводки по бурению
  function stepStyle(n: 0 | 1 | 2): React.CSSProperties {
    if (taskType !== 'drilling') return { display: 'contents' }
    return step === n ? { display: 'grid', gap: 10 } : { display: 'none' }
  }

  function handleCopyWhatsApp() {
    return copyText(buildWhatsAppMessage())
  }

  return (
    <div style={{ maxWidth: 420 }}>
      <Link
        to={`/tasks/${taskType}/${taskId}/reports`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, marginBottom: 10 }}
      >
        <ChevronLeft size={15} /> Все сводки
      </Link>
      <h1 style={{ fontSize: 18, lineHeight: 1.25, margin: '0 0 12px' }}>
        {isEditMode ? 'Правка сводки' : 'Сводка за смену'} — {wellLabel}
      </h1>

      {loadingTask ? (
        <p>Загрузка задания…</p>
      ) : (
        <form style={{ display: 'grid', gap: 10 }} onSubmit={(e) => e.preventDefault()}>
          {taskType === 'drilling' && (
            <ol className="wizard-steps" aria-label="Шаги сводки">
              {['Смена и забой', 'Что сделано', 'Затраты и отправка'].map((label, i) => (
                <li key={label} className={i === step ? 'is-current' : i < step ? 'is-done' : undefined}>
                  <span>{i < step ? '✓' : i + 1}</span>
                  {label}
                </li>
              ))}
            </ol>
          )}
          <div style={stepStyle(0)}>
          <label>
            Дата
            <input
              type="date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
              required
            />
          </label>

          {shiftsApply && (
            <label>
              Смена
              <select
                value={shiftNumber}
                onChange={(e) => setShiftNumber(e.target.value as '1' | '2')}
              >
                {taskType === 'core-sawing' ? (
                  <>
                    <option value="1">День</option>
                    <option value="2">Ночь</option>
                  </>
                ) : (
                  <>
                    <option value="1">1-я</option>
                    <option value="2">2-я</option>
                  </>
                )}
              </select>
            </label>
          )}

          <label>
            Часы работы
            <input
              type="number"
              step="any"
              value={hoursWorked}
              onChange={(e) => setHoursWorked(e.target.value)}
            />
          </label>

          {taskType === 'drilling' && (
            <fieldset>
              <legend>Забой за смену</legend>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
                <div className="text-muted" style={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                  {diamHistory.length > 0
                    ? 'Ранее бурили: ' + diamHistory.map((d) => d.code + ' ' + round2(d.from) + '–' + round2(d.to) + ' м').join(' → ') + ' (забой ' + round2(diamHistory[diamHistory.length - 1].to) + ' м)'
                    : 'Ранее диаметр бурения не вносился — выберите диаметр, которым бурите'}
                </div>
                <button
                  type="button"
                  className="icon-btn-round"
                  aria-label="Подсказка"
                  title="Подсказка"
                  onClick={() => setDiamHelpOpen(true)}
                  style={{ flexShrink: 0, width: 28, height: 28, minWidth: 28, minHeight: 28, fontWeight: 700 }}
                >
                  ?
                </button>
              </div>
              <div style={{ display: 'grid', gap: 12 }}>
                {diamSegs.map((sg, i) => {
                  const last = i === diamSegs.length - 1
                  const fromV = Number(rowFrom(i) || 0)
                  const setTo = (v: string) => {
                    const m = v === '' ? '' : String(round2(Number(v) - fromV))
                    if (last) {
                      setDrillingTo(v)
                      setMetersInput(m)
                    } else {
                      setDiamSegs((prev) => prev.map((x, j) => (j === i ? { ...x, to: v, m } : x)))
                    }
                  }
                  return (
                    <div key={i} style={{ display: 'grid', gap: 8 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                        <label style={{ display: 'grid', gap: 2 }}>
                          <span className="text-muted" style={{ fontSize: 11 }}>от, м</span>
                          <input
                            type="number"
                            step="any"
                            value={rowFrom(i)}
                            readOnly
                            title="Подставляется автоматически"
                            style={{ width: '100%' }}
                          />
                        </label>
                        <label style={{ display: 'grid', gap: 2 }}>
                          <span className="text-muted" style={{ fontSize: 11 }}>до, м</span>
                          <input
                            type="number"
                            step="any"
                            inputMode="decimal"
                            aria-label="Забой, м"
                            value={rowTo(i)}
                            onChange={(e) => setTo(e.target.value)}
                            style={{ width: '100%' }}
                          />
                        </label>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: i > 0 && last ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)', gap: 8, alignItems: 'end' }}>
                        <label style={{ display: 'grid', gap: 2 }}>
                          <span className="text-muted" style={{ fontSize: 11 }}>диаметр</span>
                          <select
                            aria-label="Диаметр бурения"
                            value={sg.code}
                            onChange={(e) => {
                              const v = e.target.value
                              setDiamSegs((prev) => prev.map((x, j) => (j === i ? { ...x, code: v } : x)))
                            }}
                            style={{ width: '100%' }}
                          >
                            <option value="">Выберите…</option>
                            {DRILL_DIAMETERS.map((d) => (
                              <option key={d.code} value={d.code}>
                                {drillDiameterLabel(d.code)}
                              </option>
                            ))}
                          </select>
                        </label>
                        {i > 0 && last && (
                          <button
                            type="button"
                            className="icon-btn-round"
                            title="Убрать смену диаметра"
                            aria-label="Убрать смену диаметра"
                            onClick={() => {
                              const prevRow = diamSegs[i - 1]
                              setDrillingTo(prevRow.to)
                              setMetersInput(prevRow.m)
                              setDiamSegs((prev) => prev.slice(0, -1))
                            }}
                          >
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
                <button
                  type="button"
                  className="btn-outline"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  disabled={drillingTo === ''}
                  title={drillingTo === '' ? 'Сначала укажите, до какого метра бурили этим диаметром' : undefined}
                  onClick={() => {
                    setDiamSegs((prev) => [
                      ...prev.slice(0, -1),
                      { ...prev[prev.length - 1], to: drillingTo, m: metersInput },
                      { code: prev[prev.length - 1].code, to: '', m: '' },
                    ])
                    setDrillingTo('')
                    setMetersInput('')
                  }}
                >
                  <Plus size={15} /> Смена диаметра
                </button>
                {diamIssue && drillingTo !== '' && <div className="text-error" style={{ fontSize: 12 }}>{diamIssue}</div>}
              </div>
              {drillingTo !== '' && (
                <div style={{ marginTop: 6, fontWeight: 600 }}>
                  Глубина скважины:{' '}
                  <span className="num">{round2(Number(drillingTo))} м</span>{' '}
                  <span className="text-muted" style={{ fontWeight: 400 }}>
                    (проходка за смену {round2(Number(drillingTo) - Number(drillingFrom || 0))} м) — это попадёт в сообщение для WhatsApp
                  </span>
                </div>
              )}
              <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={reamOn}
                    onChange={(e) => {
                      const on = e.target.checked
                      setReamOn(on)
                      if (on && reamRows.length === 0) setReamRows([{ code: '', from: '', to: '' }])
                    }}
                    style={{ width: 'auto' }}
                  />
                  Расширение ствола
                </label>
                {reamOn && (
                  <>
                    <div className="text-muted" style={{ fontSize: 13 }}>
                      Участок уже пробуренного ствола, который добурили другим диаметром. Расширение не входит в проходку — её считают поля «проходка / до» выше (в смену можно сделать и то и другое).
                    </div>
                    {reamRows.map((r, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <label style={{ display: 'grid', gap: 2 }}>
                          <span className="text-muted" style={{ fontSize: 11 }}>с, м</span>
                          <input
                            type="number"
                            step="any"
                            inputMode="decimal"
                            aria-label="Расширение с метра"
                            value={r.from}
                            onChange={(e) => {
                              const v = e.target.value
                              setReamRows((prev) => prev.map((x, j) => (j === i ? { ...x, from: v } : x)))
                            }}
                            style={{ width: 90 }}
                          />
                        </label>
                        <label style={{ display: 'grid', gap: 2 }}>
                          <span className="text-muted" style={{ fontSize: 11 }}>до, м</span>
                          <input
                            type="number"
                            step="any"
                            inputMode="decimal"
                            aria-label="Расширение до метра"
                            value={r.to}
                            onChange={(e) => {
                              const v = e.target.value
                              setReamRows((prev) => prev.map((x, j) => (j === i ? { ...x, to: v } : x)))
                            }}
                            style={{ width: 100 }}
                          />
                        </label>
                        <label style={{ display: 'grid', gap: 2 }}>
                          <span className="text-muted" style={{ fontSize: 11 }}>диаметр</span>
                          <select
                            aria-label="Диаметр расширения"
                            value={r.code}
                            onChange={(e) => {
                              const v = e.target.value
                              setReamRows((prev) => prev.map((x, j) => (j === i ? { ...x, code: v } : x)))
                            }}
                            style={{ minWidth: 130 }}
                          >
                            <option value="">Выберите…</option>
                            {DRILL_DIAMETERS.map((d) => (
                              <option key={d.code} value={d.code}>
                                {drillDiameterLabel(d.code)}
                              </option>
                            ))}
                          </select>
                        </label>
                        {reamRows.length > 1 && (
                          <button
                            type="button"
                            className="icon-btn-round"
                            title="Убрать"
                            aria-label="Убрать расширение"
                            onClick={() => setReamRows((prev) => prev.filter((_, j) => j !== i))}
                          >
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn-outline"
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                      onClick={() => setReamRows((prev) => [...prev, { code: prev[prev.length - 1]?.code ?? '', from: '', to: '' }])}
                    >
                      <Plus size={15} /> Ещё интервал
                    </button>
                  </>
                )}
              </div>
              <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                <div style={{ fontWeight: 600 }}>Обсадка</div>
                <div className="text-muted" style={{ fontSize: 13 }}>
                  {Object.keys(casingBase).length === 0
                    ? 'Не вносилась'
                    : 'Сейчас: ' +
                      Object.entries(casingBase)
                        .map(([code, d]) => code + ' до ' + round2(d) + ' м')
                        .join(', ')}
                </div>
                {casingEdits.map((c, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      aria-label="Диаметр обсадки"
                      value={c.code}
                      onChange={(e) => {
                        const v = e.target.value
                        setCasingEdits((prev) => prev.map((x, j) => (j === i ? { ...x, code: v } : x)))
                      }}
                      style={{ minWidth: 130 }}
                    >
                      <option value="">Выберите…</option>
                      {DRILL_DIAMETERS.map((d) => (
                        <option key={d.code} value={d.code}>
                          {drillDiameterLabel(d.code)}
                        </option>
                      ))}
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="text-muted">до</span>
                      <input
                        type="number"
                        step="any"
                        inputMode="decimal"
                        aria-label="Глубина обсадки, м"
                        placeholder="глубина"
                        value={c.depth}
                        onChange={(e) => {
                          const v = e.target.value
                          setCasingEdits((prev) => prev.map((x, j) => (j === i ? { ...x, depth: v } : x)))
                        }}
                        style={{ width: 100 }}
                      />
                      <span className="text-muted">м</span>
                    </label>
                    <button
                      type="button"
                      className="icon-btn-round"
                      title="Убрать"
                      aria-label="Убрать изменение обсадки"
                      onClick={() => setCasingEdits((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-outline"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  onClick={() => {
                    const codes = Object.keys(casingBase)
                    setCasingEdits((prev) => [...prev, { code: codes[codes.length - 1] ?? '', depth: '' }])
                  }}
                >
                  <Plus size={15} /> {Object.keys(casingBase).length === 0 ? 'Внести обсадку' : 'Изменить обсадку'}
                </button>
              </div>
              {knownMeters !== priorApprovedMeters && (
                <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
                  <span
                    title="Включает ещё не согласованные техдиром сводки — цифра может измениться"
                    style={{
                      display: 'inline-block',
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: 'var(--color-danger)',
                      marginRight: 5,
                      verticalAlign: 'middle',
                    }}
                  />
                  Забой не согласован — сумма может измениться после проверки техдиром
                </div>
              )}
            </fieldset>
          )}

          {taskType === 'drilling' && (
            <div className="wizard-nav">
              <button
                type="button"
                disabled={drillingTo === '' || diamIssue !== null}
                onClick={() => setStep(1)}
              >
                Далее
              </button>
              {drillingTo === '' && (
                <span className="text-muted" style={{ fontSize: 12 }}>Укажите забой «до», чтобы продолжить</span>
              )}
            </div>
          )}
          </div>

          {taskType === 'core-description' && (
            <>
              <fieldset>
                <legend>Описание керна, интервал</legend>
                <input
                  type="number"
                  step="any"
                  placeholder="от"
                  value={coreFrom}
                  readOnly
                  title="Подставляется автоматически из предыдущей сводки"
                  style={{ width: 80 }}
                />
                <input
                  type="number"
                  step="any"
                  placeholder="до"
                  value={coreTo}
                  onChange={(e) => setCoreTo(e.target.value)}
                  style={{ width: 80 }}
                />
              </fieldset>
              <fieldset>
                <legend>Фотофиксация керна, интервал</legend>
                <input
                  type="number"
                  step="any"
                  placeholder="от"
                  value={photoFrom}
                  readOnly
                  title="Подставляется автоматически из предыдущей сводки"
                  style={{ width: 80 }}
                />
                <input
                  type="number"
                  step="any"
                  placeholder="до"
                  value={photoTo}
                  onChange={(e) => setPhotoTo(e.target.value)}
                  style={{ width: 80 }}
                />
              </fieldset>
            </>
          )}

          {taskType === 'core-sawing' && (
            <label>
              Распилено за смену, м
              <input
                type="number"
                step="any"
                value={sawnMeters}
                onChange={(e) => setSawnMeters(e.target.value)}
              />
            </label>
          )}

          {taskType === 'sampling' && (
            <>
              <label>
                Проб отобрано
                <input
                  type="number"
                  step="1"
                  value={samplesTaken}
                  onChange={(e) => setSamplesTaken(e.target.value)}
                />
              </label>
              <label>
                Проб сдано в лабораторию
                <input
                  type="number"
                  step="1"
                  value={samplesSubmitted}
                  onChange={(e) => setSamplesSubmitted(e.target.value)}
                />
              </label>
            </>
          )}

          {taskType === 'drilling' && attachedGeoCore && (
            <fieldset>
              <legend>Керн, геологическая документация — интервал</legend>
              {siblingLocked.geo && (
                <p className="text-muted" style={{ fontSize: 12, margin: '0 0 6px' }}>
                  Уже согласуется отдельно от бурения — правка отсюда недоступна.
                </p>
              )}
              <input
                type="number"
                step="any"
                placeholder="от"
                value={geoCoreFrom}
                readOnly
                title="Подставляется автоматически из предыдущей сводки"
                style={{ width: 80 }}
              />
              <input
                type="number"
                step="any"
                placeholder="до"
                value={geoCoreTo}
                onChange={(e) => setGeoCoreTo(e.target.value)}
                disabled={siblingLocked.geo}
                style={{ width: 80 }}
              />
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>Фотофиксация</div>
              <input
                type="number"
                step="any"
                placeholder="от"
                value={geoPhotoFrom}
                readOnly
                style={{ width: 80 }}
              />
              <input
                type="number"
                step="any"
                placeholder="до"
                value={geoPhotoTo}
                onChange={(e) => setGeoPhotoTo(e.target.value)}
                disabled={siblingLocked.geo}
                style={{ width: 80 }}
              />
            </fieldset>
          )}

          {taskType === 'drilling' && attachedGeotechCore && (
            <fieldset>
              <legend>Керн, геотехническая документация — интервал</legend>
              {siblingLocked.geotech && (
                <p className="text-muted" style={{ fontSize: 12, margin: '0 0 6px' }}>
                  Уже согласуется отдельно от бурения — правка отсюда недоступна.
                </p>
              )}
              <input
                type="number"
                step="any"
                placeholder="от"
                value={geotechCoreFrom}
                readOnly
                title="Подставляется автоматически из предыдущей сводки"
                style={{ width: 80 }}
              />
              <input
                type="number"
                step="any"
                placeholder="до"
                value={geotechCoreTo}
                onChange={(e) => setGeotechCoreTo(e.target.value)}
                disabled={siblingLocked.geotech}
                style={{ width: 80 }}
              />
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>Фотофиксация</div>
              <input
                type="number"
                step="any"
                placeholder="от"
                value={geotechPhotoFrom}
                readOnly
                style={{ width: 80 }}
              />
              <input
                type="number"
                step="any"
                placeholder="до"
                value={geotechPhotoTo}
                onChange={(e) => setGeotechPhotoTo(e.target.value)}
                disabled={siblingLocked.geotech}
                style={{ width: 80 }}
              />
            </fieldset>
          )}

          {taskType === 'drilling' && attachedSawing && (
            <label>
              Распилено за смену, м
              {siblingLocked.sawing && (
                <span className="text-muted" style={{ fontWeight: 400, fontSize: 12 }}>
                  {' '}
                  (уже согласуется отдельно — правка отсюда недоступна)
                </span>
              )}
              <input
                type="number"
                step="any"
                value={sawnMeters}
                onChange={(e) => setSawnMeters(e.target.value)}
                disabled={siblingLocked.sawing}
              />
            </label>
          )}

          {taskType === 'drilling' && canFillAttachedSampling && (
            <>
              {siblingLocked.sampling && (
                <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
                  Опробование за эту дату уже согласуется отдельно — правка отсюда недоступна.
                </p>
              )}
              <label>
                Проб отобрано
                <input
                  type="number"
                  step="1"
                  value={samplesTaken}
                  onChange={(e) => setSamplesTaken(e.target.value)}
                  disabled={siblingLocked.sampling}
                />
              </label>
              <label>
                Проб сдано в лабораторию
                <input
                  type="number"
                  step="1"
                  value={samplesSubmitted}
                  onChange={(e) => setSamplesSubmitted(e.target.value)}
                  disabled={siblingLocked.sampling}
                />
              </label>
            </>
          )}

          <div style={stepStyle(1)}>
          <label>
            Что сделано за смену
            <textarea
              rows={3}
              placeholder="Например: метраж 5 из 10 по плану — отставание из-за замены коронки и подъёма снаряда"
              value={shiftNotes}
              onChange={(e) => setShiftNotes(e.target.value)}
            />
          </label>

          {taskType === 'drilling' && (
            <div className="wizard-nav">
              <button type="button" className="btn-outline" onClick={() => setStep(0)}>
                Назад
              </button>
              <button type="button" onClick={() => setStep(2)}>
                Далее
              </button>
            </div>
          )}
          </div>

          <div style={stepStyle(2)}>
          <CostRowsEditor
            rows={costRows}
            categories={categories}
            items={costItems}
            onChange={setCostRows}
          />

          {/* Копирование для WhatsApp — только на шаге 3. До отправки текст собирается
              из введённых значений; после отправки форма очищается, поэтому ниже
              копируется текст, сохранённый в момент отправки (оба одной функцией,
              глубина = забой «до»). */}
          {error && <p className="text-error">{error}</p>}
          {showSent && (
            <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, borderColor: 'var(--color-success)' }}>
              <p className="text-success" style={{ margin: 0, fontWeight: 600 }}>{successMsg}</p>
              {sentMessage && (
                <button
                  type="button"
                  className="btn-whatsapp"
                  onClick={() => copyText(sentMessage)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 44 }}
                >
                  {copied ? <Check size={16} /> : <MessageCircle size={16} />}
                  {copied ? 'Скопировано' : 'Скопировать для WhatsApp'}
                </button>
              )}
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  setSuccessMsg(null)
                  setSentMessage(null)
                  setStep(0)
                }}
                style={{ minHeight: 44 }}
              >
                Заполнить следующую смену
              </button>
            </div>
          )}

          {(() => {
            // Пока форма стоит на той же дате/смене, что уже была успешно
            // отправлена в этом сеансе, — кнопки заблокированы (иначе
            // случайный повторный клик создал бы вторую строку reports на
            // те же дату/смену, см. отзыв 20.09.2026). Смена даты или
            // смены снимает блокировку сама, реактивно.
            const alreadySubmittedHere =
              !isEditMode &&
              lastSubmitted !== null &&
              lastSubmitted.date === reportDate &&
              lastSubmitted.shift === shiftNumber
            const disabled = submitting !== null || alreadySubmittedHere
            return (
              <div style={{ display: 'grid', gap: 8 }}>
                <button
                  type="button"
                  className="btn-outline"
                  disabled={disabled}
                  onClick={(e) => handleSubmit(e, 'draft')}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44 }}
                >
                  {submitting === 'draft' && <span className="spinner" style={{ marginRight: 0 }} />}
                  {submitting === 'draft' ? 'Сохраняем…' : 'Сохранить черновик'}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={(e) => handleSubmit(e, 'submit')}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44 }}
                >
                  {submitting === 'submit' && <span className="spinner" style={{ marginRight: 0 }} />}
                  {submitting === 'submit'
                    ? 'Отправляем…'
                    : alreadySubmittedHere
                      ? 'Уже отправлено — измените дату/смену'
                      : 'Отправить на согласование'}
                </button>
                {taskType === 'drilling' && !showSent && (
                  <button
                    type="button"
                    className="btn-whatsapp"
                    onClick={handleCopyWhatsApp}
                    disabled={drillingTo === ''}
                    title={drillingTo === '' ? 'Укажите забой «до» на первом шаге' : undefined}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 44 }}
                  >
                    {copied ? <Check size={16} /> : <MessageCircle size={16} />}
                    {copied ? 'Скопировано' : 'Скопировать для WhatsApp'}
                  </button>
                )}
                {taskType === 'drilling' && (
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => setStep(1)}
                    style={{ minHeight: 44 }}
                  >
                    Назад
                  </button>
                )}
              </div>
            )
          })()}
          </div>
        </form>
      )}
      <Modal open={diamHelpOpen} onClose={() => setDiamHelpOpen(false)} title="Как заполнять забой">
        <div style={{ display: 'grid', gap: 10, fontSize: 14, lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}><b>«От»</b> — забой на начало смены, подставляется сам и не редактируется.</p>
          <p style={{ margin: 0 }}><b>«До»</b> — забой на конец смены. Проходка за смену считается как «до» минус «от».</p>
          <p style={{ margin: 0 }}>Выберите диаметр, которым бурили. Если диаметр сменился в течение смены, нажмите <b>«Смена диаметра»</b>: появится вторая строка, её «от» подставится из «до» предыдущей, укажите новый забой и диаметр.</p>
        </div>
      </Modal>
    </div>
  )
}
