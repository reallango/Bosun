/** Route one MCP tool call to its implementation. */
import { loadDataset, loadWidgetSpec } from '@/lib/widgets/runtime/execute';
import { serverVisible } from '@/lib/permissions/effective';
import { requirePermission } from '@/lib/permissions/authorize';
import { filterRows, resolveTarget, viewFilter } from '@/lib/widgets/runtime/resource-check';
import { runWidgetAction } from '@/lib/widgets/runtime/run-action';
import { openTerminalAction } from '@/lib/widgets/runtime/terminal-action';
import { consumeActionRateLimit } from '@/lib/utils/rate-limiter';
import type { CatalogTool, ToolResult } from './types';
import { callWidgetAction, callWidgetDataset, type ActionContext, type WidgetDeps } from './actions';
import { callCoreTool } from './core';

export const defaultWidgetDeps: WidgetDeps = {
  loadWidgetSpec,
  serverVisible,
  requirePermission,
  viewFilter,
  loadDataset,
  filterRows,
  resolveTarget,
  runWidgetAction,
  openTerminalAction,
  consumeActionRateLimit,
};

export async function callBosunTool(
  ctx: ActionContext, tool: CatalogTool, args: Record<string, unknown>, deps: WidgetDeps = defaultWidgetDeps,
): Promise<ToolResult> {
  if (tool.kind === 'dataset') return callWidgetDataset(ctx, tool, args, deps);
  if (tool.kind === 'action') return callWidgetAction(ctx, tool, args, deps);
  return callCoreTool(ctx, tool, args);
}
