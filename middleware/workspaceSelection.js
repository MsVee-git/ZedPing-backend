function resolveWorkspaceSelection(workspaces, requestedWorkspace) {
  const customerId = requestedWorkspace || (workspaces.size === 1 ? [...workspaces.keys()][0] : null)

  if (!customerId) return { kind: 'selection_required' }

  const role = workspaces.get(customerId)
  if (!role) return { kind: 'unauthorized', customerId }

  return { kind: 'authorized', customerId, role }
}

module.exports = { resolveWorkspaceSelection }
