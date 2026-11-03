import { memo, useMemo } from 'react'
import { createAvatar } from '@dicebear/core'
import { adventurer, lorelei, notionists, personas, bottts, micah } from '@dicebear/collection'

const STYLES: Record<string, any> = { adventurer, lorelei, notionists, personas, bottts, micah }
export const AVATAR_STYLES = Object.keys(STYLES)
const BACKGROUNDS = ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf', 'c7f0d8', 'fde68a', 'bae6fd']

let resolveFile: (id: number) => string = (id) => `/api/files/${id}`
export function setAvatarFileResolver(fn: (id: number) => string) {
  resolveFile = fn
}

/** "dicebear:<style>:<seed>" is drawn locally; "file:<id>" is an uploaded picture. */
export const Avatar = memo(function Avatar(props: { avatar: string; name: string; size?: number; className?: string }) {
  const { avatar, name, size = 36 } = props
  const src = useMemo(() => {
    if (avatar.startsWith('file:')) return resolveFile(Number(avatar.slice(5)))
    const [, style = 'adventurer', seed = name] = avatar.split(':')
    const collection = STYLES[style] ?? adventurer
    return createAvatar(collection, { seed, backgroundColor: BACKGROUNDS, backgroundType: ['solid'], radius: 50 }).toDataUri()
  }, [avatar, name])
  return (
    <img
      className={`avatar ${props.className ?? ''}`}
      src={src}
      alt={name}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      draggable={false}
    />
  )
})

export function randomAvatar(name: string, style = 'adventurer') {
  return `dicebear:${style}:${name || 'bot'}-${Math.floor(Math.random() * 10_000)}`
}
