/**
 * The permission the bundled Docker widget package registers for container access. Core container tools (the MCP
 * `container_exec` and a container terminal) gate on it, so it is named once here instead of in several core files.
 */
export const CONTAINER_SHELL_PERMISSION = 'docker.shell';
