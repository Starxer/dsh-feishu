import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('release configuration', () => {
  it('declares the public repository and npm package metadata', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg).toMatchObject({
      name: '@sugarforever/dsh-lark',
      repository: {
        type: 'git',
        url: 'git+https://github.com/sugarforever/dsh-lark.git',
      },
      publishConfig: { access: 'public' },
    })
  })

  it('publishes release tarballs through GitHub OIDC after all quality gates', async () => {
    const workflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
    for (const required of [
      'release:', 'types: [published]', 'id-token: write', 'npm ci', 'npm test',
      'npm run typecheck', 'npm run build', 'npm pack', 'gh release upload', 'npm publish',
      'GITHUB_REF_NAME#v',
    ]) expect(workflow).toContain(required)
    expect(workflow).not.toContain('NPM_TOKEN')
  })
})
