import { useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import { createAuxSupabaseClient } from '../lib/supabaseAuxClient'
import { useAuth } from '../context/AuthContext'
import Modal from './Modal'

const MIN_LENGTH = 6

// Смена собственного пароля. Текущий пароль проверяем отдельным входом через
// изолированный клиент (сессия не затрагивается), затем меняем пароль
// через updateUser — права в базе для этого не нужны.
export default function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  function close() {
    onClose()
    setTimeout(() => {
      setCurrent('')
      setNext('')
      setRepeat('')
      setError(null)
      setDone(false)
    }, 200)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const email = session?.user.email
    if (!email) return setError('Не удалось определить вашу учётную запись')
    if (next.length < MIN_LENGTH) return setError(`Новый пароль — минимум ${MIN_LENGTH} символов`)
    if (next !== repeat) return setError('Новый пароль и повтор не совпадают')
    if (next === current) return setError('Новый пароль должен отличаться от текущего')

    setSaving(true)
    const aux = createAuxSupabaseClient()
    const { error: checkError } = await aux.auth.signInWithPassword({ email, password: current })
    if (checkError) {
      setSaving(false)
      return setError('Текущий пароль указан неверно')
    }
    const { error: updateError } = await supabase.auth.updateUser({ password: next })
    setSaving(false)
    if (updateError) return setError(updateError.message)
    setDone(true)
  }

  return (
    <Modal open={open} onClose={close} title="Сменить пароль">
      {done ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <p className="text-success" style={{ margin: 0 }}>Пароль изменён. Используйте его при следующем входе.</p>
          <button type="button" onClick={close}>Закрыть</button>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <label>
            Текущий пароль
            <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label>
            Новый пароль
            <input type="password" required minLength={MIN_LENGTH} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label>
            Повторите новый пароль
            <input type="password" required minLength={MIN_LENGTH} autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </label>
          {error && <p className="text-error" style={{ margin: 0 }}>{error}</p>}
          <button type="submit" disabled={saving}>{saving ? 'Сохраняем…' : 'Сменить пароль'}</button>
        </form>
      )}
    </Modal>
  )
}
