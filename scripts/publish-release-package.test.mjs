import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publicationAction } from './publish-release-package.mjs'

test('publishes a version that is absent from the registry', () => {
   assert.equal(publicationAction('sha512-expected', null), 'publish')
})

test('skips only an identical existing artifact on retry', () => {
   assert.equal(publicationAction('sha512-expected', 'sha512-expected'), 'skip')
})

test('refuses a conflicting or unverifiable existing version', () => {
   assert.throws(() => publicationAction('sha512-expected', 'sha512-different'), /differs/)
   assert.throws(() => publicationAction('sha512-expected', undefined), /no usable SHA-512/)
})
