import { useEffect, useMemo, useState } from 'react'
import { isMasterProfile } from '../lib/masters'
import { supabase } from '../lib/supabaseClient'
import type { Position, Profile, WorkArea } from '../types/database'

// Кандидаты в ответственные с фильтром по направлению должности
// (03.10.2026): в списке геологических работ — только геологи, в выборе
// мастера бурения — только бурение. Люди без должности (или с должностью
// «прочее») в отфильтрованный список не попадают — для них есть «Показать
// всех». Уже выбранные значения всегда остаются в списке, даже если не
// подходят по должности, чтобы форма правки не теряла текущего человека.
export function useAreaCandidates(area: WorkArea, selectedIds: string[] = [], masterOnly = false) {
  const [all, setAll] = useState<Profile[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from('profiles').select('*').eq('role', 'party_chief').order('full_name'),
      supabase.from('positions').select('*'),
    ]).then(([profRes, posRes]) => {
      if (cancelled) return
      setAll((profRes.data ?? []) as Profile[])
      setPositions((posRes.data ?? []) as Position[])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedKey = selectedIds.join(',')
  const candidates = useMemo(() => {
    if (showAll) return all
    const areaByPosition = new Map(positions.map((p) => [p.id, p.work_area]))
    const filtered = all.filter(
      (p) => p.position_id != null && areaByPosition.get(p.position_id) === area && (!masterOnly || isMasterProfile(p, positions)),
    )
    const extra = all.filter((p) => selectedKey.split(',').includes(p.id) && !filtered.some((f) => f.id === p.id))
    return [...filtered, ...extra]
  }, [all, positions, area, showAll, selectedKey, masterOnly])

  return {
    candidates,
    all,
    allCount: all.length,
    loading,
    showAll,
    setShowAll,
    // true, если фильтр что-то скрывает — тогда имеет смысл показать «Показать всех»
    hidesSomeone: !showAll && candidates.length < all.length,
  }
}
