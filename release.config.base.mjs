export const releasePreset = {
  preset: 'conventionalcommits',
  presetConfig: {
    types: [
      { type: 'feat', section: 'Features', effect: 'bump' },
      { type: 'fix', section: 'Fixes', effect: 'bump' },
      { type: 'perf', section: 'Performance', effect: 'bump' },
      { type: 'revert', section: 'Reverts', effect: 'bump' },
      { type: 'docs', section: 'Docs' },
      { type: 'refactor', section: 'Refactor' },
      { type: 'test', section: 'Tests' },
      { type: 'build', section: 'Build' },
      { type: 'ci', section: 'CI' },
      { type: 'style', section: 'Styles', effect: 'hidden' },
      { type: 'chore', section: 'Miscellaneous Chores', effect: 'hidden' }
    ]
  }
}
