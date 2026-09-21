import type { ReactNode } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'

type ActivityCollapseProps = {
  open: boolean
  children: ReactNode
  testId?: string
}

const COLLAPSE_EASE = [0.22, 1, 0.36, 1] as const

function ActivityCollapseBody({ children, testId }: Omit<ActivityCollapseProps, 'open'>) {
  const isPresent = useIsPresent()
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      data-activity-collapse
      data-state={isPresent ? 'open' : 'closing'}
      data-testid={testId}
      aria-hidden={!isPresent}
      {...(!isPresent ? { inert: '' } : {})}
      initial={reduceMotion ? false : { gridTemplateRows: '0fr', opacity: 0, y: -3 }}
      animate={{ gridTemplateRows: '1fr', opacity: 1, y: 0 }}
      exit={{ gridTemplateRows: '0fr', opacity: 0, y: -3 }}
      transition={reduceMotion
        ? { duration: 0 }
        : { duration: 0.32, ease: COLLAPSE_EASE }}
      className="grid"
      style={{ transformOrigin: 'top' }}
    >
      <div className="min-h-0 overflow-hidden">
        {children}
      </div>
    </motion.div>
  )
}

export function ActivityCollapse({ open, children, testId }: ActivityCollapseProps) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <ActivityCollapseBody testId={testId}>
          {children}
        </ActivityCollapseBody>
      )}
    </AnimatePresence>
  )
}
