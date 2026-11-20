import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** R4 靜態防線：產品程式碼中不得寫死任何班別上限（maxCap 必須由公式推導） */
const FORBIDDEN = [/\b2880\b/, /\b5760\b/]
const SRC = path.resolve(import.meta.dirname, '..')

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return listSourceFiles(full)
    const isSource = /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
    return isSource ? [full] : []
  })
}

describe('no hard-coded maxCap', () => {
  it('src/**（不含測試檔）不出現 2880 / 5760 字面量', () => {
    const offenders = listSourceFiles(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8')
      return FORBIDDEN.some((re) => re.test(text))
    })
    expect(offenders).toEqual([])
  })
})
