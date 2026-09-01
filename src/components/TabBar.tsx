import type { TabId } from '../app/AppState'
import { TAB_ICONS, TAB_LABELS } from './icons'

interface TabBarProps {
  tab: TabId
  onChange: (tab: TabId) => void
}

export function TabBar({ tab, onChange }: TabBarProps) {
  const tabs: TabId[] = ['discover', 'playlists', 'favorites', 'profile']
  return (
    <nav className="tab-bar" aria-label="底部导航">
      {tabs.map((id) => (
        <button
          key={id}
          type="button"
          className={`tab-item${tab === id ? ' active' : ''}`}
          aria-current={tab === id ? 'page' : undefined}
          onClick={() => onChange(id)}
        >
          {TAB_ICONS[id]}
          <span>{TAB_LABELS[id]}</span>
        </button>
      ))}
    </nav>
  )
}
