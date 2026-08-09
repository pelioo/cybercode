import { createHash } from 'crypto'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { getMemoryBaseDir } from '../memdir/paths.js'
import {
  PROJECT_EXPERIENCE_FILENAME,
  getProjectExperiencePath,
} from './paths.js'
import { parsePromptMemoryInsight } from './insights.js'
import { parsePromptMemoryEntries } from './store.js'

const DEFAULT_MAX_PROJECTS = 24
const DEFAULT_MAX_ENTRIES = 120
const DEFAULT_MAX_CHARS = 24_000

export type ProjectExperienceDocument = {
  projectKey: string
  path: string
  entries: string[]
  updatedAtMs: number
}

export type ProjectExperienceCorpus = {
  projects: ProjectExperienceDocument[]
  projectCount: number
  entryCount: number
  content: string
  fingerprint: string
}

function projectKeyForPath(filePath: string): string {
  return basename(dirname(dirname(filePath))) || 'current-project'
}

async function readProjectExperienceDocument(
  filePath: string,
): Promise<ProjectExperienceDocument | null> {
  try {
    const [raw, fileStat] = await Promise.all([
      readFile(filePath, 'utf-8'),
      stat(filePath),
    ])
    const entries = parsePromptMemoryEntries(raw).entries.filter(entry => {
      const category = parsePromptMemoryInsight(entry, 'project').category
      return (
        category === 'project-method' ||
        category === 'decision' ||
        category === 'lesson'
      )
    })
    if (entries.length === 0) return null
    return {
      projectKey: projectKeyForPath(filePath),
      path: filePath,
      entries,
      updatedAtMs: fileStat.mtimeMs,
    }
  } catch {
    return null
  }
}

async function discoverProjectExperiencePaths(): Promise<string[]> {
  const paths = new Set<string>([getProjectExperiencePath()])
  const projectsRoot = join(getMemoryBaseDir(), 'projects')
  try {
    const projectDirs = await readdir(projectsRoot, { withFileTypes: true })
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue
      paths.add(
        join(
          projectsRoot,
          entry.name,
          'memory',
          PROJECT_EXPERIENCE_FILENAME,
        ).normalize('NFC'),
      )
    }
  } catch {
    // The projects directory is created lazily after the first memory write.
  }
  return [...paths]
}

export async function collectProjectExperienceCorpus(
  options: {
    maxProjects?: number
    maxEntries?: number
    maxChars?: number
  } = {},
): Promise<ProjectExperienceCorpus> {
  const maxProjects = Math.max(
    1,
    options.maxProjects ?? DEFAULT_MAX_PROJECTS,
  )
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS)
  const documents = (
    await Promise.all(
      (await discoverProjectExperiencePaths()).map(path =>
        readProjectExperienceDocument(path),
      ),
    )
  )
    .filter((document): document is ProjectExperienceDocument => Boolean(document))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, maxProjects)

  let entryCount = 0
  let charCount = 0
  const projects: ProjectExperienceDocument[] = []

  for (const document of documents) {
    const entries: string[] = []
    for (const entry of document.entries) {
      if (entryCount >= maxEntries) break
      const nextChars = entry.length + (entries.length > 0 ? 1 : 0)
      if (charCount + nextChars > maxChars) break
      entries.push(entry)
      entryCount++
      charCount += nextChars
    }
    if (entries.length > 0) {
      projects.push({ ...document, entries })
    }
    if (entryCount >= maxEntries || charCount >= maxChars) break
  }

  const content = projects
    .map((project, index) => [
      `## Project ${index + 1}`,
      ...project.entries.map(
        (entry, entryIndex) => `${entryIndex + 1}. ${entry}`,
      ),
    ].join('\n'))
    .join('\n\n')
  const fingerprint = createHash('sha256')
    .update(
      [...projects]
        .sort((left, right) => left.projectKey.localeCompare(right.projectKey))
        .map(project =>
          `${project.projectKey}\u0000${project.entries.join('\u0000')}`,
        )
        .join('\u0001'),
    )
    .digest('hex')

  return {
    projects,
    projectCount: projects.length,
    entryCount,
    content,
    fingerprint,
  }
}
