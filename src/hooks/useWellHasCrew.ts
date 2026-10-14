import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// Есть ли на скважине состав бригады (открытые назначения буровиков/помощников).
// null — ещё загружается.
export function useWellHasCrew(taskId: string | undefined, enabled = true, reloadKey = 0) {
  const [has, setHas] = useState<boolean | null>(null)
  useEffect(() => {
    if (!taskId || !enabled) {
      setHas(null)
      return
    }
    let cancelled = false
    supabase
      .from('task_worker_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('drilling_task_id', taskId)
      .is('valid_to', null)
      .in('role', ['driller', 'assistant_driller'])
      .then(({ count, error }) => {
        if (!cancelled) setHas(error ? null : (count ?? 0) > 0)
      })
    return () => {
      cancelled = true
    }
  }, [taskId, enabled, reloadKey])
  return has
}
