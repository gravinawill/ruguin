import { releasePreset } from '../../release.config.base.mjs'

export default {
  plugins: [
    ['@semantic-release/commit-analyzer', releasePreset],
    ['@semantic-release/release-notes-generator', releasePreset],
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    '@semantic-release/github',
    [
      '@semantic-release/git',
      { assets: ['CHANGELOG.md', 'package.json'], message: 'chore(release): ${nextRelease.version}' }
    ]
  ]
}
