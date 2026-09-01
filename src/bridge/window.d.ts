import type { ChkszApi } from './types'

declare global {
  interface Window {
    chksz: ChkszApi
  }
}

export {}
