import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import type { Profile, WorkArea } from '../types/database'
import { isManagement } from '../types/roles'

interface AuthContextValue {
  session: Session | null
  profile: Profile | null
  profileError: string | null
  loading: boolean
  // Индивидуальные возможности (profile_caps); начальство имеет все.
  can: (cap: string) => boolean
  // Профиль работ из должности: drilling / geology / other (null — должности нет).
  workArea: WorkArea | null
  // Может создавать задания на бурение: начальство или мастер (уровень 4, бурение).
  canCreateWells: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [workArea, setWorkArea] = useState<WorkArea | null>(null)
  const [posLevel, setPosLevel] = useState<number | null>(null)
  const [caps, setCaps] = useState<Set<string>>(new Set())

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadProfile() {
      if (!session) {
        setProfile(null)
        setProfileError(null)
        return
      }
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, role, on_duty, created_at, position_id')
        .eq('id', session.user.id)
        .single()

      if (cancelled) return

      if (error) {
        // Пользователь аутентифицирован, но для него ещё нет записи
        // в profiles (например, только что создан через Supabase Auth,
        // но администратор ещё не завёл профиль с ролью — см. supabase/README.md),
        // либо запись есть, но её не отдаёт RLS (см. код ошибки/сообщение —
        // выводим в интерфейс специально для диагностики bootstrap-сценария).
        // eslint-disable-next-line no-console
        console.error('Не удалось загрузить профиль:', error.message)
        setProfile(null)
        setProfileError(error.message)
        return
      }
      setProfile(data as Profile)
      setProfileError(null)
      const posId = (data as { position_id?: string | null }).position_id
      if (posId) {
        const { data: pos } = await supabase.from('positions').select('work_area, level').eq('id', posId).single()
        if (!cancelled) {
          setWorkArea((pos?.work_area as WorkArea | undefined) ?? null)
          setPosLevel((pos?.level as number | undefined) ?? null)
        }
      } else {
        setWorkArea(null)
        setPosLevel(null)
      }
      // Таблица может отсутствовать, пока не применена миграция 0038 — тогда прав нет.
      const { data: capRows } = await supabase.from('profile_caps').select('cap, allowed').eq('profile_id', session.user.id)
      if (!cancelled) setCaps(new Set((capRows ?? []).filter((c) => c.allowed).map((c) => c.cap as string)))
    }

    loadProfile()
    return () => {
      cancelled = true
    }
  }, [session])

  const canCreateWells = isManagement(profile?.role) || (profile?.role === 'party_chief' && posLevel === 4 && workArea === 'drilling')

  const can = (cap: string) => isManagement(profile?.role) || caps.has(cap)

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  return (
    // Пока сессия есть, а профиль ещё не пришёл (и ошибки нет) — это тоже загрузка:
    // иначе на долю секунды после входа мелькала служебная панель «профиль не
    // загрузился… Диагностика» (05.10.2026).
    <AuthContext.Provider
      value={{ session, profile, profileError, loading: loading || (!!session && !profile && !profileError), can, workArea, canCreateWells, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth должен использоваться внутри <AuthProvider>')
  return ctx
}
