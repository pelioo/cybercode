import type { Command } from '../../commands.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description: 'Manage CyberCode prompt memory and instruction files',
  argumentHint:
    'status | edit soul|brief|project|user | add brief|project|user <entry> | remove brief|project|user <text>',
  load: () => import('./memory.js'),
}

export default memory
