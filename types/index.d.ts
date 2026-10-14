export type BandCategory = {
  name: string
  kind: 'used' | 'free' | 'buffer'
  tokens: number
  themeColor: string
}

export type BandQuota = { kind: string; percentUsed: number; resetsAt?: string }

export type BandSnapshot = {
  categories: BandCategory[]
  totalTokens: number
  maxTokens: number
  compactAt?: number
  quotas: BandQuota[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-band': { snapshot: BandSnapshot | null; minute: number; isHidden: boolean }
  }
}
