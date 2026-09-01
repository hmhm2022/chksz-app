import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.chksz.music.mobile',
  appName: 'CHKSZ Music',
  webDir: 'dist',
  android: { allowMixedContent: true },
}

export default config
