import { describe, expect, it } from 'vitest'

import { fileExtension, findFileReferences, looksLikeWebUrl, parseFileReference } from '../src/webview/file-reference.js'

describe('parseFileReference', () => {
  it('parses relative, absolute, Windows, and line-anchor references', () => {
    expect(parseFileReference('src/extension.ts:41:7')).toEqual({ path: 'src/extension.ts', line: 41, column: 7 })
    expect(parseFileReference('/repo/src/app.ts#L12-L18')).toEqual({ path: '/repo/src/app.ts', line: 12 })
    expect(parseFileReference('src/app.ts:12-18')).toEqual({ path: 'src/app.ts', line: 12 })
    expect(parseFileReference('C:\\repo\\src\\app.ts:9:3')).toEqual({ path: 'C:\\repo\\src\\app.ts', line: 9, column: 3 })
    expect(parseFileReference('package.json')).toEqual({ path: 'package.json' })
  })

  it('does not turn external URLs or ordinary labels into workspace links', () => {
    expect(parseFileReference('https://example.com/src/app.ts')).toBeUndefined()
    expect(parseFileReference('reasoning-process')).toBeUndefined()
    expect(findFileReferences('Release v0.4.4 is ready.')).toEqual([])
  })

  it('keeps scheme-less web domains out of file references', () => {
    expect(parseFileReference('www.example.com')).toBeUndefined()
    expect(parseFileReference('docs.example.com/guide')).toBeUndefined()
    expect(parseFileReference('example.com/docs')).toBeUndefined()
  })

  it('ignores root-level URL fragments such as /guide', () => {
    expect(parseFileReference('/guide')).toBeUndefined()
  })

  it('does not auto-link extensionless relative paths like dir/file', () => {
    expect(parseFileReference('dir/file')).toBeUndefined()
    expect(parseFileReference('approve/request-changes')).toBeUndefined()
    expect(parseFileReference('docs/architecture')).toBeUndefined()
    expect(parseFileReference('feature/foo')).toBeUndefined()
    expect(parseFileReference('release/0.5.5')).toBeUndefined()
    expect(findFileReferences('The change lives under dir/file, keep it there.')).toEqual([])
    expect(findFileReferences('please approve/request-changes for the release')).toEqual([])
  })

  it('keeps extension, dotfile, and known extensionless references clickable', () => {
    expect(parseFileReference('dir/file.ts')).toEqual({ path: 'dir/file.ts' })
    expect(parseFileReference('src/ui/App.TSX:41:7')).toEqual({ path: 'src/ui/App.TSX', line: 41, column: 7 })
    expect(parseFileReference('dir/.env')).toEqual({ path: 'dir/.env' })
    expect(parseFileReference('dir/.gitignore')).toEqual({ path: 'dir/.gitignore' })
    expect(parseFileReference('Makefile')).toEqual({ path: 'Makefile' })
    expect(parseFileReference('README')).toEqual({ path: 'README' })
  })

  it('keeps positional anchors clickable even without an extension', () => {
    expect(parseFileReference('dir/file:12')).toEqual({ path: 'dir/file', line: 12 })
    expect(parseFileReference('dir/file:12:3')).toEqual({ path: 'dir/file', line: 12, column: 3 })
    expect(parseFileReference('docs/guide#L4')).toEqual({ path: 'docs/guide', line: 4 })
  })
})

describe('looksLikeWebUrl', () => {
  it('flags domain-shaped values', () => {
    expect(looksLikeWebUrl('www.example.com')).toBe(true)
    expect(looksLikeWebUrl('docs.example.com/guide')).toBe(true)
    expect(looksLikeWebUrl('example.com/docs')).toBe(true)
    expect(looksLikeWebUrl('https://example.com')).toBe(true)
  })

  it('leaves local file paths and bare source files alone', () => {
    expect(looksLikeWebUrl('src/app.ts')).toBe(false)
    expect(looksLikeWebUrl('package.json')).toBe(false)
    expect(looksLikeWebUrl('file.tar.gz')).toBe(false)
    expect(looksLikeWebUrl('.gitignore')).toBe(false)
  })
})

describe('findFileReferences', () => {
  it('locates clickable references in ordinary model prose', () => {
    const source = 'Update src/ui/view.ts:27, then verify package.json.'

    expect(findFileReferences(source)).toEqual([
      { path: 'src/ui/view.ts', line: 27, start: 7, end: 24 },
      { path: 'package.json', start: 38, end: 50 },
    ])
  })

  it('does not surface web-URL fragments as file references', () => {
    expect(findFileReferences('参考 docs.example.com/guide 与 example.com 文档')).toEqual([])
  })
})

describe('fileExtension', () => {
  it('extracts the lowercase extension used for file-type icons', () => {
    expect(fileExtension('src/ui/App.TSX')).toBe('tsx')
    expect(fileExtension('manifest.test.ts')).toBe('ts')
    expect(fileExtension('C:\\repo\\styles.css')).toBe('css')
  })

  it('returns nothing for dotfiles, extensionless names, and odd suffixes', () => {
    expect(fileExtension('.gitignore')).toBeUndefined()
    expect(fileExtension('Makefile')).toBeUndefined()
    expect(fileExtension('src/dir.with.dot/')).toBeUndefined()
    expect(fileExtension('archive.tar.gz')).toBe('gz')
  })
})
