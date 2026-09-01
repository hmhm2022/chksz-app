import type { ReactNode } from 'react'
import type { TabId } from '../app/AppState'

interface IconProps {
  className?: string
}

/** 包装一条 path 片段为图标组件：统一 24 视口、描边风格，透传 className。 */
const makeIcon = (children: ReactNode): React.FC<IconProps> => ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
)

/** 发现：罗盘。 */
export const CompassIcon = makeIcon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
  </>,
)

/** 歌单：列表。 */
export const ListIcon = makeIcon(
  <>
    <path d="M8 6h13" />
    <path d="M8 12h13" />
    <path d="M8 18h13" />
    <path d="M3 6h.01" />
    <path d="M3 12h.01" />
    <path d="M3 18h.01" />
  </>,
)

/** 音乐：单音符（本地歌单 hero 占位，双八分音符形态）。 */
export const MusicIcon = makeIcon(
  <>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </>,
)

/** 音乐：八分音符（竖线 + 单钩旗）。 */
export const NoteEighthIcon = makeIcon(
  <>
    <path d="M9 18V4" />
    <path d="m9 6 11-2.5" />
    <circle cx="6" cy="18" r="3" />
  </>,
)

/** 音乐：双八分音符（两根竖线 + 横梁连接，类似对勾束音符）。 */
export const NoteBeamedIcon = makeIcon(
  <>
    <path d="M9 18V5" />
    <path d="M15 16V3" />
    <path d="M9 8 15 5.5" />
    <path d="M9 12 15 9.5" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="12" cy="16" r="3" />
  </>,
)

/** 音乐：全音符（空心椭圆，无符杆，圆润休止感）。 */
export const NoteWholeIcon = makeIcon(
  <path d="M4.5 16.5C7 12.5 11 8.5 16 9c3 .4 4 2.8 3.5 5.5C18.7 19 14.5 21 11 20 7.5 19 4.3 19.5 4.5 16.5Z" />,
)

/** 收藏：心形。 */
export const HeartIcon = makeIcon(
  <path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6.3a5 5 0 1 1 7.5 6.3Z" />,
)

/** 加入歌单：列表 + 加号。 */
export const ListPlusIcon = makeIcon(
  <>
    <path d="M3 6h.01" />
    <path d="M8 6h13" />
    <path d="M3 12h.01" />
    <path d="M8 12h9" />
    <path d="M3 18h.01" />
    <path d="M8 18h5" />
    <path d="M17 15v6" />
    <path d="M14 18h6" />
  </>,
)

/** 删除/移除：垃圾桶。 */
export const TrashIcon = makeIcon(
  <>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </>,
)

/** 我的：人形。 */
export const UserIcon = makeIcon(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20a8 8 0 0 1 16 0" />
  </>,
)

/** 加载：旋转圈。 */
export const LoaderIcon = makeIcon(<path d="M21 12a9 9 0 1 1-6.2-8.56" />)

/** 密码/密钥：钥匙。 */
export const KeyIcon = makeIcon(
  <path d="m21 2-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8Zm0 0L18 5m-3 3 2 2" />,
)

/** 下载：向下的箭头进托盘。 */
export const DownloadIcon = makeIcon(
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </>,
)

/** 播放历史：时钟（回环 + 指针）。 */
export const HistoryIcon = makeIcon(
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </>,
)

/** 搜索：放大镜。 */
export const SearchIcon = makeIcon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </>,
)

/** 后退：左箭头。 */
export const BackIcon = makeIcon(<path d="M19 12H5m6 6-6-6 6-6" />)

/** 刷新：循环箭头。 */
export const RefreshIcon = makeIcon(
  <>
    <path d="M21 12a9 9 0 1 1-2.6-6.3" />
    <path d="M21 3v6h-6" />
  </>,
)

/** 播放：三角（实心，用于播放按钮）。 */
export const PlayIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z" />
  </svg>
)

/** 暂停：双竖条（实心，用于播放中按钮）。 */
export const PauseIcon = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
)

/** Tab 图标注册表：给 TabBar 用。 */
export const TAB_ICONS: Record<TabId, ReactNode> = {
  discover: <CompassIcon />,
  playlists: <ListIcon />,
  favorites: <HeartIcon />,
  profile: <UserIcon />,
}

/** Tab 名称注册表（中文展示名）。 */
export const TAB_LABELS: Record<TabId, string> = {
  discover: '发现',
  playlists: '歌单',
  favorites: '收藏',
  profile: '我的',
}
