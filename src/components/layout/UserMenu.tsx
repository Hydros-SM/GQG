import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { KeyRound, LogOut } from 'lucide-react'
import ChangePasswordModal from '../ChangePasswordModal'
import { useAuth } from '../../context/AuthContext'
import { ROLE_LABELS } from '../../types/roles'
import { shortName } from '../../lib/shortName'

function initials(fullName: string) {
  const parts = fullName.trim().split(/\s+/)
  return (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')
}

interface UserMenuProps {
  // Сайдбар открывается снизу вверх (триггер у нижнего края экрана) — вниз
  // панель просто не влезла бы. Мобильная шапка — как раньше, вниз.
  placement?: 'down' | 'up'
  // В свёрнутом сайдбаре показываем только аватар; в развёрнутом — ещё и
  // имя/роль рядом, чтобы место не пустовало.
  showLabel?: boolean
}

// Один компонент для аватара-меню и на десктопе (в сайдбаре), и в мобильной
// шапке — набор действий один и тот же (профиль/выход), нет смысла
// дублировать разметку под два экрана.
export default function UserMenu({ placement = 'down', showLabel = false }: UserMenuProps) {
  const { profile, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!profile) return null

  return (
    <div style={{ position: 'relative', width: showLabel ? '100%' : undefined }} ref={ref}>
      <button
        type="button"
        className="user-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={showLabel ? { width: '100%' } : undefined}
      >
        <span className="user-avatar">{initials(profile.full_name).toUpperCase()}</span>
        {showLabel && (
          <span style={{ minWidth: 0, textAlign: 'left' }}>
            <span style={{ display: 'block', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {shortName(profile.full_name)}
            </span>
            <span className="text-muted" style={{ display: 'block', fontSize: 11 }}>
              {ROLE_LABELS[profile.role]}
            </span>
          </span>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className={`user-menu-panel${placement === 'up' ? ' user-menu-panel-up' : ''}`}
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: placement === 'up' ? 6 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: placement === 'up' ? 6 : -6 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="user-menu-header">
              <div style={{ fontWeight: 700, fontSize: 14 }}>{shortName(profile.full_name)}</div>
              <div className="text-muted" style={{ fontSize: 12 }}>
                {ROLE_LABELS[profile.role]}
              </div>
            </div>
            <button
              type="button"
              className="user-menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                setPasswordOpen(true)
              }}
            >
              <KeyRound size={16} />
              Сменить пароль
            </button>
            <button
              type="button"
              className="user-menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                signOut()
              }}
            >
              <LogOut size={16} />
              Выйти
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  )
}
