import type { WidgetSpec } from '@/lib/widgets/runtime/spec';
import type { WidgetToolSource } from '@/lib/mcp/tools';

/** A deliberately small declarative spec used only by the MCP tests. */
export const sampleSpec = {
  version: 2,
  data: { source: 'snapshot', section: 'cpu_memory', permission: 'sample.view' },
  view: { type: 'table', columns: [] },
  actions: [
    {
      id: 'restart',
      label: 'Restart service',
      description: 'Restart one service in a container.',
      permission: 'sample.manage',
      kind: 'command',
      as: 'user',
      command: 'echo {{name}}',
      params: {
        name: { type: 'string', pattern: '^[a-z]+$', maxLength: 20, description: 'Service name' },
        force: { type: 'boolean', description: 'Force the restart' },
      },
      timeoutSec: 30,
      confirm: { title: 'Restart it?', text: 'The service restarts.', destructive: true },
      result: 'toast',
      after: 'refresh',
      target: { kind: 'container', param: 'name' },
    },
    {
      id: 'status',
      label: 'Service status',
      description: 'Show the status.',
      permission: 'sample.view',
      kind: 'command',
      as: 'user',
      command: 'true',
      params: {},
      timeoutSec: 30,
      result: 'text',
      after: 'none',
    },
    {
      id: 'open',
      label: 'Open shell',
      permission: 'sample.shell',
      kind: 'terminal',
      as: 'service',
      command: '',
      params: {},
      timeoutSec: 30,
      terminal: { ref: 'name', refPattern: '^[a-z]+$', command: 'sh' },
      result: 'none',
      after: 'none',
      target: { kind: 'container', param: 'name' },
    },
    {
      id: 'screen',
      label: 'Open screen',
      permission: 'sample.view',
      kind: 'screen',
      screen: 'details',
      as: 'user',
      command: '',
      params: {},
      timeoutSec: 30,
      result: 'none',
      after: 'none',
    },
  ],
  scripts: {
    list: {
      as: 'user',
      timeoutSec: 10,
      linux: 'list.sh',
      params: {
        stack: { type: 'string', values: ['web', 'db'], maxLength: 20, description: 'Stack name' },
        all: { type: 'boolean', default: true },
      },
    },
  },
  datasets: {
    containers: { script: 'list', cacheSec: 0, permission: 'sample.view', target: { kind: 'container', param: 'stack' } },
    rows: { script: 'list', cacheSec: 0, permission: 'sample.view', resources: { container: 'name' } },
  },
} as unknown as WidgetSpec;

export const sampleSource: WidgetToolSource = {
  type: 'sample_widget',
  displayName: 'Sample Widget',
  packageId: 'sample',
  spec: sampleSpec,
  permissionLabels: {
    'sample.view': 'See sample data',
    'sample.manage': 'Manage the sample',
    'sample.shell': 'Open a sample shell',
  },
  permissionRisks: { 'sample.view': 'low', 'sample.manage': 'high', 'sample.shell': 'high' },
};
