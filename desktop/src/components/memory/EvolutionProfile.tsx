import { useState } from 'react'
import { motion } from 'motion/react'
import { useTranslation, type TranslationKey } from '../../i18n'
import type {
  PromptMemoryInsight,
  PromptMemoryInsightCategory,
  PromptMemoryInsights,
} from '../../api/promptMemory'
import { Button } from '../shared/Button'
import { Icon } from '../shared/Icon'
import { Modal } from '../shared/Modal'
import { Textarea } from '../shared/Textarea'

const CATEGORY_KEYS: Record<PromptMemoryInsightCategory, TranslationKey> = {
  identity: 'settings.memory.insight.category.identity',
  communication: 'settings.memory.insight.category.communication',
  collaboration: 'settings.memory.insight.category.collaboration',
  workflow: 'settings.memory.insight.category.workflow',
  quality: 'settings.memory.insight.category.quality',
  boundaries: 'settings.memory.insight.category.boundaries',
  expertise: 'settings.memory.insight.category.expertise',
  'project-method': 'settings.memory.insight.category.projectMethod',
  decision: 'settings.memory.insight.category.decision',
  'meta-method': 'settings.memory.insight.category.metaMethod',
  environment: 'settings.memory.insight.category.environment',
  lesson: 'settings.memory.insight.category.lesson',
  other: 'settings.memory.insight.category.other',
}

const SOURCE_KEYS: Record<PromptMemoryInsight['source'], TranslationKey> = {
  explicit: 'settings.memory.insight.source.explicit',
  observed: 'settings.memory.insight.source.observed',
  manual: 'settings.memory.insight.source.manual',
}

const USER_CATEGORIES: PromptMemoryInsightCategory[] = [
  'identity',
  'communication',
  'collaboration',
  'workflow',
  'quality',
  'boundaries',
  'expertise',
  'other',
]

const PROJECT_CATEGORIES: PromptMemoryInsightCategory[] = [
  'project-method',
  'decision',
  'environment',
  'lesson',
]

const GLOBAL_CATEGORIES: PromptMemoryInsightCategory[] = ['meta-method']

type EntryEditor = {
  mode: 'add' | 'edit'
  target: PromptMemoryInsight['target']
  category: PromptMemoryInsightCategory
  content: string
  original?: PromptMemoryInsight
}

export type PromptMemoryEntrySave = {
  target: PromptMemoryInsight['target']
  category: PromptMemoryInsightCategory
  content: string
  original?: PromptMemoryInsight
}

export type PromptMemoryEntrySaveResult =
  | { ok: true }
  | { ok: false; error: string }

function InsightRow({
  insight,
  isRemoving,
  onEdit,
  onRemove,
  index,
}: {
  insight: PromptMemoryInsight
  isRemoving: boolean
  onEdit: (insight: PromptMemoryInsight) => void
  onRemove: (insight: PromptMemoryInsight) => void
  index: number
}) {
  const t = useTranslation()
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.18), duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
      className="group grid min-w-0 grid-cols-[32px_minmax(0,1fr)_auto] gap-[11px] border-t border-[var(--color-border-separator)] px-[16px] py-[14px] first:border-t-0 hover:bg-[var(--color-surface-hover)]"
    >
      <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] border border-[var(--color-border-separator)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-secondary)]">
        <Icon
          name={
            insight.target === 'user'
              ? 'person'
              : insight.target === 'project'
                ? 'folder'
                : 'psychology'
          }
          size={14}
        />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-[7px] gap-y-[3px] text-[10px] leading-[15px]">
          <span className="font-semibold text-[var(--color-text-secondary)]">
            {t(CATEGORY_KEYS[insight.category])}
          </span>
          <span className="h-[3px] w-[3px] rounded-full bg-[var(--color-text-tertiary)]" />
          <span className="text-[var(--color-text-tertiary)]">
            {t(SOURCE_KEYS[insight.source])}
          </span>
        </div>
        <p className="mt-[5px] whitespace-pre-wrap break-words text-[12px] leading-[19px] text-[var(--color-text-primary)]">
          {insight.content}
        </p>
      </div>
      <div className="pointer-events-none flex shrink-0 items-start gap-[2px] opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <button
          type="button"
          onClick={() => onEdit(insight)}
          className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-[6px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
          aria-label={t('settings.memory.insight.edit')}
          title={t('settings.memory.insight.edit')}
        >
          <Icon name="edit" size={13} />
        </button>
        <button
          type="button"
          disabled={isRemoving}
          onClick={() => onRemove(insight)}
          className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-[6px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-error)]/8 hover:text-[var(--color-error)] disabled:opacity-40"
          aria-label={t('settings.memory.insight.remove')}
          title={t('settings.memory.insight.remove')}
        >
          <Icon name={isRemoving ? 'loading' : 'delete'} size={13} className={isRemoving ? 'animate-spin' : ''} />
        </button>
      </div>
    </motion.div>
  )
}

function InsightGroup({
  title,
  icon,
  insights,
  emptyText,
  removingId,
  onEdit,
  onRemove,
  onAdd,
}: {
  title: string
  icon: 'person' | 'folder' | 'psychology'
  insights: PromptMemoryInsight[]
  emptyText: string
  removingId: string | null
  onEdit: (insight: PromptMemoryInsight) => void
  onRemove: (insight: PromptMemoryInsight) => void
  onAdd: () => void
}) {
  const t = useTranslation()
  return (
    <section className="min-w-0 border-t border-[var(--color-border-separator)] first:border-t-0">
      <header className="flex min-h-[58px] items-center gap-[10px] border-b border-[var(--color-border-separator)] px-[16px] py-[11px]">
        <Icon name={icon} size={16} className="shrink-0 text-[var(--color-text-secondary)]" />
        <h3 className="w-full max-w-none whitespace-normal text-[13px] font-semibold leading-[19px] text-[var(--color-text-primary)]">
          {title}
        </h3>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[6px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
          aria-label={t('settings.memory.insight.add')}
          title={t('settings.memory.insight.add')}
        >
          <Icon name="add" size={14} />
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          {insights.length}
        </span>
      </header>
      <div>
        {insights.length === 0 ? (
          <p className="px-[18px] py-[24px] text-center text-[11px] leading-[17px] text-[var(--color-text-tertiary)]">
            {emptyText}
          </p>
        ) : insights.map((insight, index) => (
          <InsightRow
            key={insight.id}
            insight={insight}
            index={index}
            isRemoving={removingId === insight.id}
            onEdit={onEdit}
            onRemove={onRemove}
          />
        ))}
      </div>
    </section>
  )
}

function MemoryEntryEditor({
  editor,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  editor: EntryEditor
  saving: boolean
  error: string | null
  onChange: (next: EntryEditor) => void
  onClose: () => void
  onSave: () => void
}) {
  const t = useTranslation()
  const baseCategories = editor.target === 'user'
    ? USER_CATEGORIES
    : editor.target === 'project'
      ? PROJECT_CATEGORIES
      : GLOBAL_CATEGORIES
  const categories = baseCategories.includes(editor.category)
    ? baseCategories
    : [editor.category, ...baseCategories]
  const trimmedContent = editor.content.trim()

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      title={t(editor.mode === 'add'
        ? 'settings.memory.insight.addTitle'
        : 'settings.memory.insight.editTitle')}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onSave} loading={saving} disabled={!trimmedContent}>
            {editor.mode === 'add' ? t('common.add') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        <div>
          <label
            htmlFor="prompt-memory-entry-category"
            className="mb-[7px] block text-[12px] font-semibold text-[var(--color-text-primary)]"
          >
            {t('settings.memory.insight.categoryLabel')}
          </label>
          <div className="relative">
            <select
              id="prompt-memory-entry-category"
              value={editor.category}
              onChange={(event) => onChange({
                ...editor,
                category: event.target.value as PromptMemoryInsightCategory,
              })}
              disabled={saving}
              className="h-[40px] w-full appearance-none rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-[12px] pr-[38px] text-[12px] font-medium text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)] disabled:opacity-50"
            >
              {categories.map(category => (
                <option key={category} value={category}>
                  {t(CATEGORY_KEYS[category])}
                </option>
              ))}
            </select>
            <Icon
              name="expand_more"
              size={16}
              className="pointer-events-none absolute right-[11px] top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"
            />
          </div>
        </div>

        <div>
          <Textarea
            id="prompt-memory-entry-content"
            label={t('settings.memory.insight.contentLabel')}
            value={editor.content}
            onChange={(event) => onChange({
              ...editor,
              content: event.target.value,
            })}
            disabled={saving}
            rows={5}
            maxLength={220}
            autoFocus
            error={error ?? undefined}
            className="min-h-[132px] rounded-[8px] text-[12px] leading-[19px]"
            placeholder={t('settings.memory.insight.contentPlaceholder')}
          />
          <div className="mt-[6px] text-right font-mono text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
            {editor.content.length}/220
          </div>
        </div>

      </div>
    </Modal>
  )
}

export function EvolutionProfile({
  overview,
  removingId,
  onRemove,
  onSaveEntry,
}: {
  overview: PromptMemoryInsights | null
  removingId: string | null
  onRemove: (insight: PromptMemoryInsight) => void
  onSaveEntry: (
    entry: PromptMemoryEntrySave,
  ) => Promise<PromptMemoryEntrySaveResult>
}) {
  const t = useTranslation()
  const [editor, setEditor] = useState<EntryEditor | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const userInsights = overview?.insights.filter(insight => insight.target === 'user') ?? []
  const projectInsights = overview?.insights.filter(insight => insight.target === 'project') ?? []
  const globalInsights = overview?.insights.filter(insight => insight.target === 'brief') ?? []
  const stats = overview?.stats ?? {
    total: 0,
    user: 0,
    project: 0,
    globalMethods: 0,
    methods: 0,
    dimensions: 0,
    automaticUpdates: 0,
  }
  const summary = [
    ['settings.memory.insight.stat.total', stats.total],
    ['settings.memory.insight.stat.user', stats.user],
    ['settings.memory.insight.stat.project', stats.project],
    ['settings.memory.insight.stat.global', stats.globalMethods],
  ] as const

  const openAddEditor = (target: PromptMemoryInsight['target']) => {
    setSaveError(null)
    setEditor({
      mode: 'add',
      target,
      category:
        target === 'user'
          ? 'collaboration'
          : target === 'project'
            ? 'project-method'
            : 'meta-method',
      content: '',
    })
  }

  const openEditEditor = (insight: PromptMemoryInsight) => {
    setSaveError(null)
    setEditor({
      mode: 'edit',
      target: insight.target,
      category: insight.category,
      content: insight.content,
      original: insight,
    })
  }

  const closeEditor = () => {
    if (isSaving) return
    setEditor(null)
    setSaveError(null)
  }

  const saveEditor = async () => {
    if (!editor || !editor.content.trim()) return
    setIsSaving(true)
    setSaveError(null)
    try {
      const result = await onSaveEntry({
        target: editor.target,
        category: editor.category,
        content: editor.content.trim(),
        original: editor.original,
      })
      if (result.ok) {
        setEditor(null)
      } else {
        setSaveError(result.error)
      }
    } catch {
      setSaveError(t('settings.memory.insight.saveFailed'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      <section
        data-testid="evolution-profile"
        className="overflow-hidden rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]"
      >
        <div className="grid grid-flow-dense grid-cols-2 divide-x divide-y divide-[var(--color-border-separator)] border-b border-[var(--color-border-separator)] sm:grid-cols-4 sm:divide-y-0">
          {summary.map(([key, value], index) => (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.04, duration: 0.22 }}
              className="min-w-0 px-[16px] py-[13px]"
            >
              <strong className="font-mono text-[19px] font-semibold tabular-nums text-[var(--color-text-primary)]">{value}</strong>
              <div className="mt-[3px] whitespace-normal text-[10px] leading-[15px] text-[var(--color-text-secondary)]">{t(key)}</div>
            </motion.div>
          ))}
        </div>
        <InsightGroup
          title={t('settings.memory.insight.userTitle')}
          icon="person"
          insights={userInsights}
          emptyText={t('settings.memory.insight.userEmpty')}
          removingId={removingId}
          onEdit={openEditEditor}
          onRemove={onRemove}
          onAdd={() => openAddEditor('user')}
        />
        <InsightGroup
          title={t('settings.memory.insight.projectTitle')}
          icon="folder"
          insights={projectInsights}
          emptyText={t('settings.memory.insight.projectEmpty')}
          removingId={removingId}
          onEdit={openEditEditor}
          onRemove={onRemove}
          onAdd={() => openAddEditor('project')}
        />
        <InsightGroup
          title={t('settings.memory.insight.methodTitle')}
          icon="psychology"
          insights={globalInsights}
          emptyText={t('settings.memory.insight.methodEmpty')}
          removingId={removingId}
          onEdit={openEditEditor}
          onRemove={onRemove}
          onAdd={() => openAddEditor('brief')}
        />
      </section>

      {editor && (
        <MemoryEntryEditor
          editor={editor}
          saving={isSaving}
          error={saveError}
          onChange={setEditor}
          onClose={closeEditor}
          onSave={() => void saveEditor()}
        />
      )}
    </>
  )
}
