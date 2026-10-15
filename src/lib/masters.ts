import type { Position } from '../types/database'

// Мастер — ответственный с должностью уровня 4 и профилем «бурение» (14.10.2026).
// Только такие люди предлагаются в списках «Мастер» / «Бригадир».
export function isMasterProfile(p: { role: string; position_id: string | null }, positions: Position[]): boolean {
  if (p.role !== 'party_chief' || !p.position_id) return false
  const pos = positions.find((x) => x.id === p.position_id)
  return !!pos && pos.level === 4 && pos.work_area === 'drilling'
}
