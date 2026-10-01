import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type { SourceFile } from 'typescript/unstable/ast'
import { API, type Program } from 'typescript/unstable/sync'
import type { GitTree } from './git-at.js'

/** Parse baseline blobs with the repository's TypeScript compiler. The working tree is not a source. */
export class SourceFiles {
  private program: Program | undefined

  private constructor(
    private readonly api: API,
    private readonly files: Map<string, string>,
    private readonly temp: string,
  ) {}

  static open(tree: GitTree, paths: readonly string[]): SourceFiles {
    const temp = mkdtempSync(join(tmpdir(), 'baseline-inventory-'))
    const files = new Map<string, string>()
    try {
      for (const path of [...paths].sort()) {
        const absolute = join(temp, path)
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, tree.text(path))
        files.set(path, absolute)
      }
      writeFileSync(
        join(temp, 'tsconfig.json'),
        `${JSON.stringify({
          compilerOptions: {
            strict: true,
            target: 'es2023',
            module: 'nodenext',
            moduleResolution: 'nodenext',
            noEmit: true,
            noLib: true,
            skipLibCheck: true,
          },
          files: [...files.keys()].sort(),
        })}\n`,
      )
      const api = new API({ cwd: temp })
      const opened = new SourceFiles(api, files, temp)
      opened.prepare()
      return opened
    } catch (error) {
      rmSync(temp, { recursive: true, force: true })
      throw error
    }
  }

  file(path: string): SourceFile {
    const absolute = this.files.get(path)
    if (!absolute) throw new Error(`baseline source was not opened: ${path}`)
    const program = this.readProgram()
    const source = program.getSourceFile(absolute)
    if (!source) throw new Error(`compiler did not parse ${path}`)
    const diagnostics = program.getSyntacticDiagnostics(absolute)
    if (diagnostics.length > 0) {
      const detail = diagnostics.map((item) => item.text).join('; ')
      throw new Error(`${path} did not parse: ${detail}`)
    }
    return source
  }

  close(): void {
    this.api.close()
    rmSync(this.temp, { recursive: true, force: true })
  }

  private prepare(): void {
    this.readProgram()
  }

  private readProgram() {
    if (this.program) return this.program
    const projects = this.api
      .updateSnapshot({ openProjects: [join(this.temp, 'tsconfig.json')] })
      .getProjects()
    const project = projects.find(
      (item) =>
        item.configFileName.endsWith(`${sep}tsconfig.json`) || item.configFileName.endsWith('/tsconfig.json'),
    )
    if (!project) throw new Error('compiler opened no project')
    this.program = project.program
    return project.program
  }
}
