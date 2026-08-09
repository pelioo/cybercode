import { describe, expect, test } from 'bun:test'
import agentWorkRulesSection from '../defaults/agent-work-rules.md' with {
  type: 'text',
}
import {
  ANT_NUMERIC_LENGTH_PATCH,
  getModelPolicyContributions,
  renderActivePolicyOverrides,
  renderCommunicationPolicySection,
  resolvePromptPolicy,
  type PromptPolicyContribution,
} from './promptPolicy.js'

describe('prompt policy compiler', () => {
  test('renders one canonical communication section', () => {
    const section = renderCommunicationPolicySection()

    expect(section.match(/^# Communication$/gm)).toHaveLength(1)
    expect(section).toContain('Keep simple answers short')
    expect(section).toContain('add detail when complexity')
    expect(section).not.toContain('# Tone and style')
    expect(section).not.toContain('# Output efficiency')
  })

  test('keeps engineering execution in one canonical section', () => {
    expect(
      agentWorkRulesSection.match(/^# Engineering Execution$/gm),
    ).toHaveLength(1)
    expect(agentWorkRulesSection).toContain('Read the relevant code and context')
    expect(agentWorkRulesSection).toContain('smallest complete change')
    expect(agentWorkRulesSection).toContain(
      'stop making symptom-level patches',
    )
    expect(agentWorkRulesSection).toContain(
      'smallest complete root-cause fix',
    )
    expect(agentWorkRulesSection).toContain('Report outcomes exactly')
    expect(agentWorkRulesSection).not.toContain('# Agent Work Rules')
  })

  test('resolves policy fields by source priority', () => {
    const contributions: PromptPolicyContribution[] = [
      {
        source: 'model',
        label: 'Model',
        communication: { verbosity: 'concise', maxFinalWords: 100 },
      },
      {
        source: 'user-memory',
        label: 'User memory',
        communication: { verbosity: 'adaptive' },
      },
      {
        source: 'optimization',
        label: 'Caveman',
        communication: { verbosity: 'compressed' },
        execution: { discipline: 'strict' },
      },
      {
        source: 'output-style',
        label: 'Output style',
        communication: { verbosity: 'adaptive' },
      },
    ]

    const resolved = resolvePromptPolicy(contributions)
    expect(resolved.communication.verbosity).toBe('adaptive')
    expect(resolved.communication.maxFinalWords).toBe(100)
    expect(resolved.execution.discipline).toBe('strict')
  })

  test('renders model, optimization, output-style, and user deltas once', () => {
    const section = renderActivePolicyOverrides([
      ...getModelPolicyContributions('ant'),
      {
        source: 'user-memory',
        label: 'User memory',
        communication: { instructions: ['Reply in concise Chinese.'] },
        execution: { instructions: ['Run an end-to-end check.'] },
      },
      {
        source: 'optimization',
        label: 'Caveman',
        communication: { verbosity: 'compressed' },
      },
      {
        source: 'optimization',
        label: 'Ponytail',
        execution: { discipline: 'strict' },
      },
      {
        source: 'output-style',
        label: 'Output style: Explanatory',
        communication: { instructions: ['Explain important choices.'] },
      },
    ])!

    expect(section.match(/^# Active Policy Overrides$/gm)).toHaveLength(1)
    expect(section.match(/^## Communication$/gm)).toHaveLength(1)
    expect(section.match(/^## Engineering Execution$/gm)).toHaveLength(1)
    expect(section).toContain('Compression mode is active')
    expect(section).toContain('at most 25 words')
    expect(section).toContain('at most 100 words')
    expect(section).toContain('Reply in concise Chinese.')
    expect(section).toContain('Run an end-to-end check.')
    expect(section).toContain('Explain important choices.')
    expect(section).not.toContain('# Caveman')
    expect(section).not.toContain('# Ponytail')
    expect(section).not.toContain('Length limits:')
  })

  test('deduplicates identical dynamic instructions', () => {
    const section = renderActivePolicyOverrides([
      {
        source: 'user-memory',
        label: 'User memory',
        execution: { instructions: ['Run focused tests.'] },
      },
      {
        source: 'output-style',
        label: 'Output style',
        execution: { instructions: ['  Run   focused tests.  '] },
      },
    ])!

    expect(section.match(/Run\s+focused tests\./g)).toHaveLength(1)
  })

  test('keeps model-patch ownership and expiry metadata explicit', () => {
    expect(ANT_NUMERIC_LENGTH_PATCH).toMatchObject({
      id: 'ant-numeric-length-anchors',
      topic: 'communication',
      appliesTo: 'USER_TYPE=ant',
    })
    expect(ANT_NUMERIC_LENGTH_PATCH.reason.length).toBeGreaterThan(20)
    expect(ANT_NUMERIC_LENGTH_PATCH.expiresWhen.length).toBeGreaterThan(20)
  })
})
