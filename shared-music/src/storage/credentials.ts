import { systemBridge } from '../../../src/systemBridge'

/**
 * ChKSz API 密钥存储（移动版）。
 *
 * 走原生 SystemPlugin 的 EncryptedSharedPreferences（Keystore 主密钥 +
 * AES256 双层加密）持久化，不再使用 @capacitor/preferences 键值存储占位。
 * 保持 hasKey / getKey / setKey 语义不变，chksz_ 前缀校验仍在 setKey 内。
 * 非 Capacitor 环境（纯浏览器 typecheck/调试）下原生桥会 reject，
 * getKey 统一归一为"密钥未设置"/"密钥存储不可用"，行为与旧实现一致。
 */
export class CredentialStore {
  async hasKey(): Promise<boolean> {
    try {
      return (await this.getKey()).length > 0
    } catch {
      return false
    }
  }

  async getKey(): Promise<string> {
    try {
      const value = await systemBridge.getSecureKey()
      if (value === '') throw new Error('密钥未设置')
      return value
    } catch (error) {
      if ((error as Error)?.message === '密钥未设置') throw error
      throw new Error('密钥存储不可用')
    }
  }

  async setKey(value: string): Promise<void> {
    const key = value.trim()
    if (!key.startsWith('chksz_')) throw new Error('密钥格式不正确')
    try {
      await systemBridge.setSecureKey(key)
    } catch {
      throw new Error('密钥存储不可用')
    }
  }
}