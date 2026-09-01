export interface LyricLine { time: number; text: string }

export function parseLrc(value: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const rawLine of value.split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)]
    if (!timestamps.length) continue
    const text = rawLine.replace(/\[[^\]]+\]/g, '').trim()
    for (const match of timestamps) {
      const fraction = Number(`0.${(match[3] ?? '0').padEnd(3, '0')}`)
      lines.push({ time: Number(match[1]) * 60 + Number(match[2]) + fraction, text })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

export function activeLyricIndex(lines: LyricLine[], seconds: number): number {
  let result = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.time > seconds) break
    result = index
  }
  return result
}