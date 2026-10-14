import { expect, it } from 'vitest'
import { workflowStepRecord } from '../src/workflow-step.js'

it('reads a workflow stage record and leaves prose alone', () => {
  expect(workflowStepRecord('approve-plan:\n{\n  "plan": {\n    "required": false\n  }\n}')).toEqual({
    name: 'approve-plan',
    data: { plan: { required: false } },
  })
  expect(workflowStepRecord('Note:\n{"a":1}')).toBeUndefined()
  expect(workflowStepRecord('playbook:\n[1, 2]')).toBeUndefined()
  expect(workflowStepRecord('account:\n{not json}')).toBeUndefined()
  expect(workflowStepRecord('Here is the plan:\n{"a":1} and more')).toBeUndefined()
  expect(workflowStepRecord('Presented report.md')).toBeUndefined()
})
